import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.types.js";
import config from "../config/config.js";
import type { MonitoredAccount } from "../interfaces/monitoredAccount.interface.js";
import { FIRST_THRESHOLD_WITH_BUFFER, SECOND_THRESHOLD_WITH_BUFFER } from "../config/constants.js";
import { retryWithBackoff } from "@quartz-labs/sdk";

export class Supabase {
    public supabase: SupabaseClient<Database>;

    constructor() {
        this.supabase = createClient<Database>(
            config.SUPABASE_URL,
            config.SUPABASE_KEY
        );
    }

    public async getAccounts(): Promise<MonitoredAccount[]> {
        const accounts = await retryWithBackoff(
            async () => {
                const { data, error } = await this.supabase
                    .from('monitored_accounts')
                    .select('*');
                if (error) throw error;
                return data;
            }
        );

        const monitoredAccounts = accounts.map((account) => ({
            address: account.address,
            chatId: account.chat_id,
            lastHealth: account.last_health,
            notifyAtFirstThreshold: account.notify_at_first_threshold,
            notifyAtSecondThreshold: account.notify_at_second_threshold,
        }));

        return monitoredAccounts;
    }

    public async addAccount(
        address: string, 
        chatId: number, 
        health: number
    ): Promise<void> {
        if (await this.entryExists(address)) {
            throw new Error(`Account ${address} already exists in Supabase`);
        }

        await retryWithBackoff(
            async () => {
                const { error } = await this.supabase
                    .from('monitored_accounts')
                    .insert({
                        address: address,
                        chat_id: chatId,
                        last_health: health,
                        notify_at_first_threshold: (health >= FIRST_THRESHOLD_WITH_BUFFER),
                        notify_at_second_threshold: (health >= SECOND_THRESHOLD_WITH_BUFFER)
                    });
                if (error) throw error;
            }
        );
    }

    public async updateAccount(
        address: string, 
        health: number,
        notifyAtFirstThreshold: boolean,
        notifyAtSecondThreshold: boolean
    ): Promise<void> {
        if (!await this.entryExists(address)) {
            throw new Error(`Account ${address} does not exist in Supabase`);
        }

        await retryWithBackoff(
            async () => {
                const { error } = await this.supabase
                    .from('monitored_accounts')
                    .update({
                        last_health: health,
                        notify_at_first_threshold: notifyAtFirstThreshold,
                        notify_at_second_threshold: notifyAtSecondThreshold
                    })
                    .eq('address', address);
                if (error) throw error;
            }
        );
    }

    public async removeAccounts(addresses: string[]) {
        await retryWithBackoff(
            async () => {
                const { error } = await this.supabase
                    .from('monitored_accounts')
                    .delete()
                    .in('address', addresses);
                if (error) throw error;
            }
        );
    }

    async entryExists(address: string): Promise<boolean> {
        const entry = await retryWithBackoff(
            async () => {
                const { data, error } = await this.supabase
                    .from('monitored_accounts')
                    .select()
                    .eq('address', address)
                    .single();
                if (error) throw error;
                return data;
            }
        );
        return !!entry;
    }
}
