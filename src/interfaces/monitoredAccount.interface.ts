export interface MonitoredAccount {
    address: string;
    chatId: number;
    lastHealth: number;
    notifyAtFirstThreshold: boolean;
    notifyAtSecondThreshold: boolean;
}
