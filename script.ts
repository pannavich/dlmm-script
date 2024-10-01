import {
    Connection,
    Keypair,
    PublicKey,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import DLMM, { BinLiquidity, LbPosition, StrategyType } from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import dotenv from 'dotenv';
  
dotenv.config();

const user = Keypair.fromSecretKey(
new Uint8Array(bs58.decode(process.env.USER_PRIVATE_KEY!))
);
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
// const RPC = "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "finalized");

const poolAddress = new PublicKey("DbTk2SNKWxu9TJbPzmK9HcQCAmraBCFb5VMo8Svwh34z"); // JLP/USDC
const token0 = new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"); // JLP
const token1 = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

/** Utils */
export interface ParsedClockState {
info: {
    epoch: number;
    epochStartTimestamp: number;
    leaderScheduleEpoch: number;
    slot: number;
    unixTimestamp: number;
};
type: string;
program: string;
space: number;
}


async function getSolBalance() {
    const solBalance = await connection.getBalance(user.publicKey);
    return solBalance/1e9;
}

async function getSolBalanceLamport() {
    const solBalance = await connection.getBalance(user.publicKey);
    return solBalance;
}

async function getTokenAmount(token: PublicKey) {
    const tokenAccounts = await connection.getTokenAccountsByOwner(
        user.publicKey,
        {
            mint: token,
        }
    );

    if (tokenAccounts.value.length > 0) {
        const tokenAmount = await connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        return tokenAmount.value;
    } else {
        return null;
    }
}


async function getActiveBin(dlmmPool: DLMM) {
    // Get pool state
    const activeBin = await dlmmPool.getActiveBin();
    return activeBin;
}

async function createBalancePosition(dlmmPool: DLMM, xAmount: number, rangePerSide: number) {
    const activeBin = await getActiveBin(dlmmPool);

    const minBinId = activeBin.binId - rangePerSide;
    const maxBinId = activeBin.binId + rangePerSide;

    const newBalancePosition = new Keypair();

    const activeBinPricePerToken = dlmmPool.fromPricePerLamport(
        Number(activeBin.price)
    );
    const totalXAmount = new BN(xAmount);
    const totalYAmount = totalXAmount.mul(new BN(Number(activeBinPricePerToken)));

    // Create Position
    const createPositionTx =
        await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: newBalancePosition.publicKey,
            user: user.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
                maxBinId,
                minBinId,
                strategyType: StrategyType.SpotBalanced,
            },
        });

    try {
        const createBalancePositionTxHash = await sendAndConfirmTransaction(
            connection,
            createPositionTx,
            [user, newBalancePosition]
        );
        console.log(
            "🚀 ~ createBalancePositionTxHash:",
            createBalancePositionTxHash
        );
        return newBalancePosition;
    } catch (error) {
        console.log("🚀 ~ error:", JSON.parse(JSON.stringify(error)));
    }
    return null;
}

async function createImBalancePosition(dlmmPool: DLMM, xAmount: number, yAmount: number, rangePerSide: number) {
    const activeBin = await getActiveBin(dlmmPool);

    const minBinId = activeBin.binId - rangePerSide;
    const maxBinId = activeBin.binId + rangePerSide;

    const newImBalancePosition = new Keypair();

    const totalXAmount = new BN(xAmount);
    const totalYAmount = new BN(yAmount);

    // Create Position
    const createPositionTx =
        await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: newImBalancePosition.publicKey,
            user: user.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
                maxBinId,
                minBinId,
                strategyType: StrategyType.SpotImBalanced,
            },
            slippage: 0.02
        });

    try {
        const createImBalancePositionTxHash = await sendAndConfirmTransaction(
            connection,
            createPositionTx,
            [user, newImBalancePosition]
        );
        console.log(
            "🚀 ~ createImBalancePositionTxHash:",
            createImBalancePositionTxHash
        );
        return newImBalancePosition;
    } catch (error) {
        console.log("🚀 ~ error:", JSON.parse(JSON.stringify(error)));
    }
    return null;
}

async function swap(dlmmPool: DLMM, amount: number, swapXtoY: boolean) {
    const swapAmount = new BN(amount);
    // Swap quote
    const binArrays = await dlmmPool.getBinArrayForSwap(swapXtoY);

    const swapQuote = await dlmmPool.swapQuote(
        swapAmount, 
        swapXtoY, 
        new BN(100), // 1%
        binArrays
    );

    console.log("🚀 ~ swapQuote:", swapQuote);

    // Swap
    const swapTx = await dlmmPool.swap({
        inToken: dlmmPool.tokenX.publicKey,
        binArraysPubkey: swapQuote.binArraysPubkey,
        inAmount: swapAmount,
        lbPair: dlmmPool.pubkey,
        user: user.publicKey,
        minOutAmount: swapQuote.minOutAmount,
        outToken: dlmmPool.tokenY.publicKey,
    });

    try {
        const swapTxHash = await sendAndConfirmTransaction(connection, swapTx, [
        user,
        ]);
        console.log("🚀 ~ swapTxHash:", swapTxHash);
    } catch (error) {
        console.log("🚀 ~ error:", JSON.parse(JSON.stringify(error)));
    }
}

async function rebalance(dlmmPool: DLMM) {
    console.log("🚀 ~ Rebalancing");
    const activeBin = await getActiveBin(dlmmPool);
    const activeBinPricePerToken = dlmmPool.fromPricePerLamport(
        Number(activeBin.price)
    );

    const token0Balance = await getTokenAmount(token0);
    const token1Balance = await getTokenAmount(token1);

    console.log("🚀 ~ token0Balance:", token0Balance?.uiAmount);
    console.log("🚀 ~ token1Balance:", token1Balance?.uiAmount);

    // Calculate the total value in terms of token1 (USDC)
    const token0Value = (token0Balance?.uiAmount || 0) * Number(activeBinPricePerToken);
    const token1Value = token1Balance?.uiAmount || 0;
    const totalValue = token0Value + token1Value;

    // Calculate the target amount for each token (half of the total value)
    const targetAmount = totalValue / 2;

    // Determine which token to swap and how much
    if ((token0Value - token1Value) / totalValue > 0.05) {
        // Swap excess token0 to token1
        const excessToken0 = (token0Value - targetAmount) / Number(activeBinPricePerToken);
        const excessToken0Amount = Math.floor(excessToken0 * 10**token0Balance!.decimals);
        console.log("🚀 ~ excessToken0:", excessToken0);
        console.log(`Swapping ${excessToken0} ${token0.toString()} to ${token1.toString()}`);
        await swap(dlmmPool, excessToken0Amount, true); // true for swapping X to Y
    } else if ((token1Value - token0Value) / totalValue > 0.05) {
        // Swap excess token1 to token0
        const excessToken1 = token1Value - targetAmount;
        const excessToken1Amount = Math.floor(excessToken1 * 10**token1Balance!.decimals);
        console.log("🚀 ~ excessToken1:", excessToken1);
        console.log(`Swapping ${excessToken1} ${token1.toString()} to ${token0.toString()}`);
        await swap(dlmmPool, excessToken1Amount, false); // false for swapping Y to X
    } else {
        console.log("🚀 ~ No need to rebalance");
        return {
            totalXAmount: new BN(token0Balance?.amount || 0),
            totalYAmount: new BN(token1Balance?.amount || 0)
        }
    }

    // Recalculate balances after swap
    const updatedToken0Balance = await getTokenAmount(token0);
    const updatedToken1Balance = await getTokenAmount(token1);
    console.log("🚀 ~ Updated token0Balance:", updatedToken0Balance?.uiAmount);
    console.log("🚀 ~ Updated token1Balance:", updatedToken1Balance?.uiAmount);

    // Calculate the amounts for creating a balanced position
    const xAmount = updatedToken0Balance?.uiAmount || 0;
    const totalXAmount = new BN(xAmount);
    const totalYAmount = totalXAmount.mul(new BN(Number(activeBinPricePerToken)));

    return { totalXAmount, totalYAmount };
}

async function getAllUserPositions(user: PublicKey) {
    const positionsMap = await DLMM.getAllLbPairPositionsByUser(
        connection,
        user
      );
      return positionsMap;
}

async function isPositionInRange(pubkey: PublicKey, dlmmPool: DLMM) {
    const positionsMap = await getAllUserPositions(user.publicKey);
    const activeBin = await getActiveBin(dlmmPool);
    const position = positionsMap.get(dlmmPool.pubkey.toString())?.lbPairPositionsData.find((position: LbPosition) => position.publicKey.equals(pubkey));
    if (position) {
        return activeBin.binId >= position.positionData.lowerBinId && activeBin.binId <= position.positionData.upperBinId;
    }
    return false;
}

async function getPosition(pubkey: PublicKey, dlmmPool: DLMM) {
    const positionsMap = await getAllUserPositions(user.publicKey);
    const position = positionsMap.get(dlmmPool.pubkey.toString())?.lbPairPositionsData.find((position: LbPosition) => position.publicKey.equals(pubkey));
    return position;
}

async function removePositionLiquidity(pubkey: PublicKey, dlmmPool: DLMM) {
    console.log("🚀 ~ Removing position liquidity");
    // Remove Liquidity
    const position = await getPosition(pubkey, dlmmPool);

    if (!position) {
        console.log("removePositionLiquidity: Position not found");
        return;
    }

    const binIdsToRemove = position.positionData.positionBinData.map(
        (bin) => bin.binId
    );
    let removeLiquidityTx = await dlmmPool.removeLiquidity({
        position: pubkey,
        user: user.publicKey,
        binIds: binIdsToRemove,
        bps: new BN(100 * 100),
        shouldClaimAndClose: true, // should claim swap fee and close position together
    });

    if (Array.isArray(removeLiquidityTx)) {
        removeLiquidityTx = removeLiquidityTx[0];
    }


    try {
        const removeBalanceLiquidityTxHash = await sendAndConfirmTransaction(
            connection,
            removeLiquidityTx,
            [user],
            { skipPreflight: false, preflightCommitment: "confirmed" }
        );
        console.log(
            "🚀 ~ removeBalanceLiquidityTxHash:",
            removeBalanceLiquidityTxHash
        );
    } catch (error) {
        console.log("🚀 ~ error:", JSON.parse(JSON.stringify(error)));
    }
}

async function main() {
    const dlmmPool = await DLMM.create(connection, poolAddress);
    let currentPosition: PublicKey | null = null;

    while (true) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const solBalance = await getSolBalance();
        console.log("🚀 ~ solBalance:", solBalance);
        const token0Balance = await getTokenAmount(token0);
        console.log("🚀 ~ token0Balance:", token0Balance?.uiAmount);
        const token1Balance = await getTokenAmount(token1);
        console.log("🚀 ~ token1Balance:", token1Balance?.uiAmount);
        if (solBalance < 0.1) {
            console.log("Not enough SOL to create position");
            continue;
        }

        if (!currentPosition) {
            // Check if there is a position 
            const positionsMap = await getAllUserPositions(user.publicKey);
            const position = positionsMap.get(dlmmPool.pubkey.toString());
            if (position) {
                console.log("🚀 ~ Found position: ", position.lbPairPositionsData[0].publicKey.toString());
                currentPosition = position.lbPairPositionsData[0].publicKey;
                continue;
            } else {
                const { totalXAmount, totalYAmount } = await rebalance(dlmmPool);
                const positionKeyPair = await createImBalancePosition(dlmmPool, totalXAmount, totalYAmount, 10)
                if (positionKeyPair) {
                    currentPosition = positionKeyPair.publicKey;
                } else {
                    console.log("🥺 ~ Failed to create position");
                    continue;
                }
            }
        } else {
            if (await isPositionInRange(currentPosition, dlmmPool)) {
                console.log("🚀 ~ Position is in range");
            } else {
                console.log("🥺 ~ Position is out of range");
                await removePositionLiquidity(currentPosition, dlmmPool);
                currentPosition = null;
            }
        }
    }

}

main();