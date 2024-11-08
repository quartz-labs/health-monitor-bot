import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wallet, DriftClient, User as DriftUser } from "@drift-labs/sdk";
import { HELIUS_RPC_URL, LOCAL_SECRET } from "../utils/config.js";

export class DriftClientManager {
    private driftClient!: DriftClient;
    private connection!: Connection;
    private wallet!: Wallet;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;
    private baseReconnectDelay: number = 1000;
    private initialized: boolean = false;
    private initializationPromise: Promise<void>;

    constructor() {
        this.initializationPromise = this.initializeDriftClient();
    }

    private async initializeDriftClient() {
        try {
            this.connection = new Connection(HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com');
 
            const secret = JSON.parse(LOCAL_SECRET ?? "") as number[]
            const secretKey = Uint8Array.from(secret)
            const keypair = Keypair.fromSecretKey(secretKey)

            this.wallet = new Wallet(keypair);

            console.log("wallet created with keypair:", this.wallet.publicKey.toBase58());


            this.driftClient = new DriftClient({
                connection: this.connection,
                wallet: this.wallet,
                env: 'mainnet-beta',
            });

            await this.driftClient.subscribe();
            console.log('DriftClient initialized and subscribed successfully');
            this.reconnectAttempts = 0;
            this.initialized = true;
        } catch (error) {
            console.error('Error initializing DriftClient:', error);
            this.handleReconnection();
            throw error;
        }
    }

    private async handleReconnection() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts);
            console.log(`Attempting to reconnect in ${delay}ms...`);
            setTimeout(() => {
                this.reconnectAttempts++;
                this.initializeDriftClient();
            }, delay);
        } else {
            console.error('Max reconnection attempts reached. Please check your connection and try again later.');
        }
    }

    public async waitForInitialization(): Promise<void> {
        return this.initializationPromise;
    }

    public async getUserHealth(address: string) {
        await this.waitForInitialization();
        await this.emulateAccount(new PublicKey(address));
        const user = this.getUser();
        return user.getHealth();
    }

    public async getSpotMarketAccount(marketIndex: number) {
        return await this.driftClient.getSpotMarketAccount(marketIndex);
    }

    getUser(): DriftUser {
        return this.driftClient.getUser();
    }

    async emulateAccount(address: PublicKey) {
        await this.driftClient.emulateAccount(address);
    }
}