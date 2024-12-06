import config from "./config/config.js";
import { AppLogger } from "./utils/logger.js";
import express from "express";
import cors from "cors";
import hpp from "hpp";
import helmet from "helmet";
import { DriftClient, fetchUserAccountsUsingKeys, UserAccount, Wallet } from "@drift-labs/sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Telegram } from "./clients/telegramClient.js";
import { getAddressDisplay, getDriftUser, getQuartzHealth, getUser, getVault, retryHTTPWithBackoff } from "./utils/helpers.js";
import { DriftUser } from "./model/driftUser.js";
import { retryRPCWithBackoff } from "./utils/helpers.js";
import { Supabase } from "./clients/supabaseClient.js";
import { LOOP_DELAY, FIRST_THRESHOLD_WITH_BUFFER, SECOND_THRESHOLD_WITH_BUFFER, FIRST_THRESHOLD, SECOND_THRESHOLD, QUARTZ_PROGRAM_ID, DRIFT_MARKET_INDEX_SOL, DRIFT_MARKET_INDEX_USDC, SUPPORTED_DRIFT_MARKETS } from "./config/constants.js";
import { MonitoredAccount } from "./interfaces/monitoredAccount.interface.js";
import { BorshInstructionCoder, Idl, Instruction } from "@coral-xyz/anchor";
import idl from "./idl/quartz.json";
import { Logs } from "@solana/web3.js";

export class HealthMonitorBot extends AppLogger {
    private connection: Connection;
    private driftClient: DriftClient; 
    private driftInitPromise: Promise<boolean>;

    private telegram: Telegram;
    private supabase: Supabase;
    private monitoredAccounts: Map<string, MonitoredAccount>;
    private loadedAccountsPromise: Promise<void>;

    constructor() {
        super("Health Monitor Bot");

        this.connection = new Connection(config.RPC_URL);
        const wallet = new Wallet(Keypair.generate());
        this.driftClient = new DriftClient({
            connection: this.connection,
            wallet: wallet,
            env: 'mainnet-beta',
            userStats: false,
            perpMarketIndexes: [],
            spotMarketIndexes: SUPPORTED_DRIFT_MARKETS,
            accountSubscription: {
                type: 'websocket',
                commitment: "confirmed"
            }
        });
        this.driftInitPromise = this.driftClient.subscribe();

        this.telegram = new Telegram(
            this.startMonitoring.bind(this),
            this.stopMonitoring.bind(this)
        );
        this.supabase = new Supabase();
        this.monitoredAccounts = new Map();
        this.loadedAccountsPromise = this.loadStoredAccounts();
    }

    private async loadStoredAccounts(): Promise<void> {
        await this.driftInitPromise;

        const accounts = await this.supabase.getAccounts();

        for (const account of accounts) {
            this.monitoredAccounts.set(account.address, {
                address: account.address,
                chatId: account.chatId,
                lastHealth: account.lastHealth,
                notifyAtFirstThreshold: account.notifyAtFirstThreshold,
                notifyAtSecondThreshold: account.notifyAtSecondThreshold
            });
        }
    }

    private async startMonitoring(address: string, chatId: number) {
        try {
            let driftUser: DriftUser;
            try {
                driftUser = await getUser(address, this.connection, this.driftClient);
            } catch (error) {
                await this.telegram.api.sendMessage(
                    chatId, 
                    "I couldn't find a Quartz account with this wallet address. Please send the address of a wallet that's been used to create a Quartz account."
                );
                return;
            }

            const driftHealth = driftUser.getHealth();
            const quartzHealth = getQuartzHealth(driftHealth);

            if (this.monitoredAccounts.has(address)) {
                await this.telegram.api.sendMessage(
                    chatId, 
                    `That account is already being monitored, it's current health is ${quartzHealth}%`
                );
                return;
            }

            await this.supabase.addAccount(address, chatId, quartzHealth);
            this.monitoredAccounts.set(address, {
                address: address,
                chatId: chatId,
                lastHealth: quartzHealth,
                notifyAtFirstThreshold: (quartzHealth >= FIRST_THRESHOLD_WITH_BUFFER),
                notifyAtSecondThreshold: (quartzHealth >= SECOND_THRESHOLD_WITH_BUFFER)
            });

            await this.telegram.api.sendMessage(
                chatId, 
                `I've started monitoring your Quartz account health! I'll send you a message if:\n` +
                `- Your health drops below 25%\n` +
                `- Your health drops below 10%\n` +
                `- Your loan is auto-repaid using your collateral (at 0%)\n\n` +
                `Your current account health is ${quartzHealth}%`
            );
            await this.telegram.api.sendMessage(
                chatId, 
                `Be sure to turn on notifications in your Telegram app to receive alerts! 🔔`
            );
            await this.telegram.api.sendMessage(
                chatId, 
                `Send /stop to stop receiving messages.`
            );
            this.logger.info(`Started monitoring account ${address}`);
        } catch (error) {
            this.logger.error(`Error starting monitoring for account ${address}: ${error}`);
            await this.telegram.api.sendMessage(
                chatId, 
                `Sorry, something went wrong. I've notified the team and we'll look into it ASAP.`
            );
        }
    }

    private async stopMonitoring(chatId: number) {
        try {
            const addresses: string[] = [];
            for (const [address, data] of this.monitoredAccounts.entries()) {
                if (data.chatId === chatId) addresses.push(address);
            }

            if (addresses.length === 0) {
                await this.telegram.api.sendMessage(
                    chatId,
                    "You don't have any accounts being monitored."
                );
                return;
            }

            await this.supabase.removeAccounts(addresses);
            for (const address of addresses) {
                this.monitoredAccounts.delete(address);
            }

            await this.telegram.api.sendMessage(
                chatId,
                `I've stopped monitoring your Quartz accounts. Just send another address if you want me to start monitoring again!`
            );
            this.logger.info(`Stopped monitoring accounts: ${addresses.join(", ")}`);
        } catch (error) {
            this.logger.error(`Error stopping monitoring for chat ${chatId}: ${error}`);
            await this.telegram.api.sendMessage(
                chatId, 
                `Sorry, something went wrong. I've notified the team and we'll look into it ASAP.`
            );
        }
    }

    private async fetchDriftUsers(vaults: PublicKey[]): Promise<(UserAccount | undefined)[]> {
        return await fetchUserAccountsUsingKeys(
            this.connection, 
            this.driftClient!.program, 
            vaults.map((vault) => getDriftUser(vault))
        );
    } 

    public async start() {
        await this.loadedAccountsPromise;
        await this.setupAutoRepayListener();
        this.logger.info(`Health Monitor Bot initialized`);

        setInterval(() => {
            this.logger.info(`[${new Date().toISOString()}] Heartbeat | Monitored accounts: ${this.monitoredAccounts.size}`);
        }, 1000 * 60 * 60 * 24); // Every 24 hours

        while (true) {
            const entries = Array.from(this.monitoredAccounts.entries());
            const vaults = entries.map((entry) => getVault(new PublicKey(entry[0])));
            let driftUsers: (UserAccount | undefined)[];

            try {
                driftUsers = await retryRPCWithBackoff(
                    async () => this.fetchDriftUsers(vaults),
                    3,
                    1_000,
                    this.logger
                );
            } catch (error) {
                this.logger.error(`Error fetching drift users: ${error}`);
                continue;
            }

            for (let i = 0; i < entries.length; i++) { 
                const [address, account] = entries[i];
                const displayAddress = getAddressDisplay(address);

                if (!driftUsers[i]) {
                    this.logger.warn(`Drift user not found for account ${address}`);
                    continue;
                }

                let currentHealth: number;
                try {
                    const driftUser = new DriftUser(vaults[i], this.connection, this.driftClient!, driftUsers[i]);
                    const driftHealth = driftUser.getHealth();
                    currentHealth = getQuartzHealth(driftHealth);
                } catch (error) {
                    this.logger.error(`Error finding Drift User for ${address}: ${error}`);
                    continue;
                }

                if (currentHealth === account.lastHealth) continue;
                let notifyAtFirstThreshold = account.notifyAtFirstThreshold;
                let notifyAtSecondThreshold = account.notifyAtSecondThreshold;

                try {
                    if (notifyAtSecondThreshold && account.lastHealth > SECOND_THRESHOLD && currentHealth <= SECOND_THRESHOLD) {
                        notifyAtSecondThreshold = false;
                        await retryHTTPWithBackoff(
                            async () => this.telegram.api.sendMessage(
                                account.chatId,
                                `🚨 Your account health (${displayAddress}) has dropped to ${currentHealth}%. If you don't add more collateral, your loans will be auto-repaid at market rate!`
                            ),
                            3,
                            1_000,
                            this.logger
                        );
                        this.logger.info(`Sending health warning to ${address} (was ${account.lastHealth}%, now ${currentHealth}%)`);
                    } else if (notifyAtFirstThreshold && account.lastHealth > FIRST_THRESHOLD && currentHealth <= FIRST_THRESHOLD) {
                        notifyAtFirstThreshold = false;
                        await retryHTTPWithBackoff(
                            async () => this.telegram.api.sendMessage(
                                account.chatId,
                                `Your account health (${displayAddress}) has dropped to ${currentHealth}%. Please add more collateral to your account to avoid your loans being auto-repaid.`
                            ),
                            3,
                            1_000,
                            this.logger
                        );
                        this.logger.info(`Sending health warning to ${address} (was ${account.lastHealth}%, now ${currentHealth}%)`);
                    }
                } catch (error) {
                    this.logger.error(`Error sending notification for ${address}: ${error}`);
                    continue;
                }

                if (currentHealth >= FIRST_THRESHOLD_WITH_BUFFER) notifyAtFirstThreshold = true;
                if (currentHealth >= SECOND_THRESHOLD_WITH_BUFFER) notifyAtSecondThreshold = true;

                try {
                    this.monitoredAccounts.set(address, {
                        address: address,
                        chatId: account.chatId,
                        lastHealth: currentHealth,
                        notifyAtFirstThreshold: notifyAtFirstThreshold,
                        notifyAtSecondThreshold: notifyAtSecondThreshold
                    });
                    this.supabase.updateAccount(address, currentHealth, notifyAtFirstThreshold, notifyAtSecondThreshold);
                } catch (error) {
                    this.logger.error(`Error updating account ${address} in database: ${error}`);
                }
            }

            await new Promise(resolve => setTimeout(resolve, LOOP_DELAY));
        }
    }

    private async setupAutoRepayListener() {
        const INSRTUCTION_NAME = "AutoRepayStart";
        const ACCOUNT_INDEX_OWNER = 5;
        const ACCOUNT_INDEX_CALLER = 0;

        const analyzeQuartzLogs = async (logs: Logs) => {
            if (!logs.logs.some(log => log.includes(INSRTUCTION_NAME))) return;

            try {
                const tx = await this.connection.getTransaction(logs.signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });
                if (!tx) throw new Error(`Transaction not found`);

                const encodedIxs = tx.transaction.message.compiledInstructions;
                const accountKeys = tx.transaction.message.staticAccountKeys;

                const coder = new BorshInstructionCoder(idl as Idl);
                for (const ix of encodedIxs) {
                    try {
                        const quartzIx = coder.decode(Buffer.from(ix.data), "base58");
                        if (quartzIx?.name.toLowerCase() === INSRTUCTION_NAME.toLowerCase()) {
                            const caller = accountKeys[
                                ix.accountKeyIndexes[ACCOUNT_INDEX_CALLER]
                            ].toString();

                            const owner = accountKeys[
                                ix.accountKeyIndexes[ACCOUNT_INDEX_OWNER]
                            ].toString();

                            const monitoredAccount = this.monitoredAccounts.get(owner);

                            if (monitoredAccount) {
                                if (caller === owner) {
                                    this.logger.info(`Detected manual repay for account ${owner}`);
                                    return;
                                }

                                await this.telegram.api.sendMessage(
                                    monitoredAccount.chatId,
                                    `💰 Your loans for account ${getAddressDisplay(owner)} have automatically been repaid by selling your collateral at market rate.`
                                );
                                this.logger.info(`Sending auto-repay notification for account ${owner}`);
                            } else if (caller !== owner) {
                                this.logger.info(`Detected auto-repay for unmonitored account ${owner}`);
                            }

                            return;
                        }
                    } catch (e) { continue; }
                }
                
                throw new Error(`Could not decode instruction`);
            } catch (error) {
                this.logger.error(`Error processing ${INSRTUCTION_NAME} instruction for ${logs.signature}: ${error}`);
            }
        }

        this.connection.onLogs(
            QUARTZ_PROGRAM_ID,
            analyzeQuartzLogs,
            "confirmed"    
        );
    }
}
