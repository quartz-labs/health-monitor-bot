import { BN, DRIFT_PROGRAM_ID, DriftClient, PublicKey } from "@drift-labs/sdk";
import { QUARTZ_PROGRAM_ID, QUARTZ_HEALTH_BUFFER_PERCENTAGE } from "../config/constants.js";
import { Logger } from "winston";
import { DriftUser } from "../model/driftUser.js";
import { Connection } from "@solana/web3.js";

export function bnToDecimal(bn: BN, decimalPlaces: number): number {
    const decimalFactor = Math.pow(10, decimalPlaces);
    return bn.toNumber() / decimalFactor;
}

export const getVault = (owner: PublicKey) => {
    const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.toBuffer()],
        new PublicKey(QUARTZ_PROGRAM_ID)
    )
    return vault;
}

export const getDriftUser = (authority: PublicKey) => {
    const [userPda] = PublicKey.findProgramAddressSync(
        [
			Buffer.from("user"),
			authority.toBuffer(),
			new BN(0).toArrayLike(Buffer, 'le', 2),
		],
		new PublicKey(DRIFT_PROGRAM_ID)
    );
    return userPda;
}

export const getUser = async (address: string, connection: Connection, driftClient: DriftClient) => {
    const vault = getVault(new PublicKey(address));
    const driftUser = new DriftUser(vault, connection, driftClient);
    await retryRPCWithBackoff(
        async () => driftUser.initialize(),
        3,
        500
    );
    return driftUser;
}

export const getQuartzHealth = (driftHealth: number): number => {
    if (driftHealth <= 0) return 0;
    if (driftHealth >= 100) return 100;

    return Math.floor(
        Math.min(
            100,
            Math.max(
                0,
                (driftHealth - QUARTZ_HEALTH_BUFFER_PERCENTAGE) / (1 - (QUARTZ_HEALTH_BUFFER_PERCENTAGE / 100))
            )
        )
    );
}

export function getAddressDisplay(address: string) {
    return `${address.slice(0, 4)}...${address.slice(-4)}` 
}

export const retryRPCWithBackoff = async <T>(
    fn: () => Promise<T>,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    return retryWithBackoff(
        fn,
        "503",
        "RPC node unavailable",
        retries,
        initialDelay,
        logger
    );
}

export const retryHTTPWithBackoff = async <T>(
    fn: () => Promise<T>,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    return retryWithBackoff(
        fn,
        "HttpError",
        "HTTP network request failed",
        retries,
        initialDelay,
        logger
    );
}

export const retryWithBackoff = async <T>(
    fn: () => Promise<T>,
    errorContains: string,
    warnString: string,
    retries: number,
    initialDelay: number,
    logger?: Logger
): Promise<T> => {
    let lastError: any;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error: any) {
            lastError = error;
            if (error?.message?.includes(errorContains)) {
                const delay = initialDelay * Math.pow(2, i);
                if (logger) logger.warn(`${warnString}, retrying in ${delay}ms...`);
                
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}