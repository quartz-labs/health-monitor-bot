import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Database } from "../types/database.types";
import config from "../config/config";
import { MonitoredAccount } from "../interfaces/monitoredAccount.interface";

export class Supabase {
    public supabase: SupabaseClient<Database>;

    constructor() {
        this.supabase = createClient<Database>(
            config.SUPABASE_URL,
            config.SUPABASE_KEY
        );
    }

    public async getAccounts(): Promise<MonitoredAccount[]> {
        const { data: accounts, error } = await this.supabase
            .from('monitored_accounts')
            .select('*');
        if (error) throw error;

        const monitoredAccounts = accounts.map((account) => ({
            address: account.address,
            chatId: account.chat_id,
            lastHealth: account.last_health,
        }));

        return monitoredAccounts;
    }

    public async addAccount(
        address: string, 
        chatId: number, 
        health: number
    ): Promise<void> {
        const { data: existingEntry } = await this.supabase
            .from('monitored_accounts')
            .select()
            .eq('address', address)
            .single();

        if (existingEntry) throw new Error(`Account ${address} already exists in Supabase`);

        await this.supabase
            .from('monitored_accounts')
            .insert({
                address: address,
                chat_id: chatId,
                last_health: health
            });
    }

    public async updateAccount(
        address: string, 
        health: number
    ): Promise<void> {
        const { data: existingEntry } = await this.supabase
            .from('monitored_accounts')
            .select()
            .eq('address', address)
            .single();

        if (!existingEntry) throw new Error(`Account ${address} does not exist in Supabase`);

        await this.supabase
            .from('monitored_accounts')
            .update({
                last_health: health
            });
    }

    public async removeAccounts(addresses: string[]) {
        const { error } = await this.supabase
            .from('monitored_accounts')
            .delete()
            .in('address', addresses);
        if (error) throw error;
    }
}