import {
    Connection,
    Keypair,
    PublicKey,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
    VersionedTransaction,
    sendAndConfirmRawTransaction
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import DLMM, { BinLiquidity, LbPosition, StrategyType } from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import dotenv from 'dotenv';
  
dotenv.config();

// PK and RPC
const user = Keypair.fromSecretKey(
new Uint8Array(bs58.decode(process.env.USER_PRIVATE_KEY!))
);
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
// const RPC = "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "finalized");

// CONFIG
const poolAddress = new PublicKey("DbTk2SNKWxu9TJbPzmK9HcQCAmraBCFb5VMo8Svwh34z"); // JLP/USDC
const token0 = new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"); // JLP
const token1 = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
const totalBinRange = 40;
const rebalanceSlippage = 0.02;
const poolSlippage = 0.01;
const rebalanceMaxAttempts = 3;
const addLiquidityMaxAttempts = 3;
const removeLiquidityMaxAttempts = 3;


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

async function createBalancePosition(dlmmPool: DLMM, xAmount: number, rangePerSide: number, poolSlippage: number) {
    console.log("🚀 ~ Creating balance position");
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
            slippage: poolSlippage*100
        });

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
}

// TODO: Not working right now
async function createImBalancePosition(dlmmPool: DLMM, xAmount: number, yAmount: number, rangePerSide: number) {
    console.log("🚀 ~ Creating imbalance position");

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
        new BN(200), // 2%
        binArrays
    );

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
        throw error;
    }
}

async function swapJup(token0_amount: number, token0_address: string, token1_address: string, slippage: number) {
    console.log(`Swapping ${token0_amount} ${token1.toString()} to ${token0.toString()}`);
    const quoteResponse = await (
        await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${token0_address}&outputMint=${token1_address}&amount=${token0_amount}&slippageBps=${Math.floor(slippage * 100)}`)
    ).json();

    const { swapTransaction } = await (
        await fetch('https://quote-api.jup.ag/v6/swap', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            // quoteResponse from /quote api
            quoteResponse,
            // user public key to be used for the swap
            userPublicKey: user.publicKey.toString(),
            // auto wrap and unwrap SOL. default is true
            wrapAndUnwrapSol: true,
          })
        })
      ).json();

    // deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([user]);
    const rawTransaction = transaction.serialize()
    try {
        const latestBlockHash = await connection.getLatestBlockhash();
        const swapTxHash = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2
          });
          await connection.confirmTransaction({
           blockhash: latestBlockHash.blockhash,
           lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
           signature: swapTxHash
          });
        console.log("🚀 ~ swapTxHash:", swapTxHash);
    } catch (error) {
        throw error;
    }

}

async function rebalance(dlmmPool: DLMM, rebalanceSlippage: number) {
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
        try {
            await swapJup(excessToken0Amount, token0.toString(), token1.toString(), rebalanceSlippage); 
        } catch (error) {
            throw error;
        }
    } else if ((token1Value - token0Value) / totalValue > 0.05) {
        // Swap excess token1 to token0
        const excessToken1 = token1Value - targetAmount;
        const excessToken1Amount = Math.floor(excessToken1 * 10**token1Balance!.decimals);
        console.log("🚀 ~ excessToken1:", excessToken1);
        try {
            await swapJup(excessToken1Amount, token1.toString(), token0.toString(), rebalanceSlippage); 
        } catch (error) {
            throw error;
        }
    } else {
        console.log("🚀 ~ No need to rebalance");
        return {
            totalXAmount: new BN(token0Balance?.amount || 0),
            totalYAmount: new BN(token1Balance?.amount || 0)
        }
    }

    // Recalculate balances after swap
    console.log("🚀 ~ Rebalanced: Waiting for 5 seconds");
    await new Promise(resolve => setTimeout(resolve, 5000));

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
        throw error;
    }
}

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const dlmmPool = await DLMM.create(connection, poolAddress);
    let currentPosition: PublicKey | null = null;

    while (true) {
        await delay(30000);
        // Check sol balance
        const solBalance = await getSolBalance();
        console.log("🚀 ~ solBalance:", solBalance);

        // If not enough SOL to create position, skip
        if (solBalance < 0.07) {
            console.log("Not enough SOL to create position");
            continue;
        }

        // If no current position, check if there is a position and set it as current position
        if (!currentPosition) {
            // Check if there is a position 
            const positionsMap = await getAllUserPositions(user.publicKey);
            const position = positionsMap.get(dlmmPool.pubkey.toString());
            if (position) {
                console.log("🚀 ~ Found position: ", position.lbPairPositionsData[0].publicKey.toString());
                currentPosition = position.lbPairPositionsData[0].publicKey;
                continue;
            } else {
                let totalXAmount: BN | null = null;
                let totalYAmount: BN | null = null;

                // Check token0 and token1 balance and see if need to rebalance
                let rebalanceAttempts = 0;
                while (rebalanceAttempts < rebalanceMaxAttempts) {  
                    try {
                        rebalanceAttempts++;
                        ({ totalXAmount, totalYAmount } = await rebalance(dlmmPool, rebalanceSlippage));
                        break;
                    } catch (error) {
                        console.log("🚀 ~ rebalance (attempt " + rebalanceAttempts + ") error:", JSON.parse(JSON.stringify(error)));
                        await delay(5000);
                    }
                } 
                if (rebalanceAttempts >= rebalanceMaxAttempts) {
                    console.log("🥺 ~ Failed to rebalance after maximum attempts");
                    continue;
                } 

                // Create position
                let addLiquidityAttempts = 0;
                while (addLiquidityAttempts < addLiquidityMaxAttempts) {
                    try {
                        addLiquidityAttempts++;
                        const updatedToken0Balance = await getTokenAmount(token0);

                        const positionKeyPair = await createBalancePosition(dlmmPool, Math.floor(Number(updatedToken0Balance?.amount) * 0.9), Math.floor(totalBinRange/2), poolSlippage)
                        currentPosition = positionKeyPair.publicKey;
                        break;
                    } catch (error) {
                        console.log("🚀 ~ createBalancePosition (attempt " + addLiquidityAttempts + ") error:", JSON.parse(JSON.stringify(error)));
                        await delay(5000);
                    }
                } 
                if (addLiquidityAttempts >= addLiquidityMaxAttempts) {
                    console.log("🥺 ~ Failed to create position after maximum attempts");
                    continue;
                }
            }
        } else {
            if (await isPositionInRange(currentPosition, dlmmPool)) {
                console.log("🚀 ~ Position is in range");
            } else {
                console.log("🥺 ~ Position is out of range");

                // Remove Liquidity
                let removeLiquidityAttempts = 0;
                while (removeLiquidityAttempts < removeLiquidityMaxAttempts) {
                    try {
                        removeLiquidityAttempts++;
                        await removePositionLiquidity(currentPosition!, dlmmPool);
                        currentPosition = null;
                        break;
                    } catch (error) {
                        console.log("🚀 ~ removePositionLiquidity (attempt " + removeLiquidityAttempts + ") error:", JSON.parse(JSON.stringify(error)));
                        await delay(5000);
                    }
                } 
                if (removeLiquidityAttempts >= removeLiquidityMaxAttempts) {
                    console.log("🥺 ~ Failed to remove position after maximum attempts");
                    continue;
                }
            }
        }
    }

}

main();