import axios from "axios";
import "dotenv/config";
import {
  Keypair,
  Connection,
  clusterApiUrl,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { NetworkId } from "../../constant";

// Constants
const SOLANA_PRIVATEKEY = "YOUR_SOLANA_PRIVATE_KEY";
const FROM_TOKEN_ADDRESS = "So11111111111111111111111111111111111111112";
const TO_TOKEN_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT_ADDRESS = "YOUR_RECIPIENT_ADDRESS";

const AMOUNT_IN = 100000; // 0.01 SOL

const SLIPPAGE_PERCENTAGE = 0.5;

// Setup Signer
const solanaSigner = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATEKEY));
const solanaProvider = new Connection(
  clusterApiUrl("mainnet-beta"),
  "confirmed"
);

export const sendSolanaTransaction = async (
  provider: Connection,
  transaction: VersionedTransaction
): Promise<string> => {
  // Pre-serialize the transaction
  const serializedTx = transaction.serialize();

  // Configure retry strategy
  const RETRY_INTERVAL_MS = 5000;
  const MAX_ATTEMPTS = 15;
  const STATUS_CHECK_TIMEOUT_MS = 5000;
  const blockhash = transaction.message.recentBlockhash as string;

  let lastError: Error | null = null;
  let attempt = 0;
  let signature: string | null = null;

  // Execute retry loop
  while (attempt < MAX_ATTEMPTS) {
    attempt++;

    try {
      // If we have a signature, check if confirmed
      if (signature) {
        try {
          const status = await provider.getSignatureStatus(signature, {
            searchTransactionHistory: true,
          });

          if (
            status?.value?.confirmationStatus === "confirmed" ||
            status?.value?.confirmationStatus === "finalized"
          ) {
            return signature;
          }
        } catch (statusError) {
          signature = null;
        }
      }

      // Send new transaction if needed
      if (!signature || (attempt > 3 && (attempt - 4) % 3 === 0)) {
        if (attempt > 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_INTERVAL_MS)
          );
        }

        signature = await provider.sendRawTransaction(serializedTx, {
          maxRetries: 3,
          preflightCommitment: "confirmed",
          skipPreflight: true,
        });

        try {
          await Promise.race([
            provider.confirmTransaction(
              { signature, blockhash, lastValidBlockHeight: 0 },
              "confirmed"
            ),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Timeout")),
                STATUS_CHECK_TIMEOUT_MS
              )
            ),
          ]);
          return signature;
        } catch (confirmError) {
          // Continue to next iteration
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      }
    } catch (error: any) {
      lastError = error as Error;

      if (error.message.includes("0x1771")) {
        throw new Error("Slippage: Out Amount less than the slippage amount");
      }

      signature = null;
    }
  }
  if (signature) {
    return signature;
  }
  throw (
    lastError ||
    new Error(`Failed to send transaction after ${MAX_ATTEMPTS} attempts`)
  );
};
export const kanaswap = async () => {
  const response = await axios.get("https://ag.kanalabs.io/v1/swapQuote", {
    params: {
      inputToken: FROM_TOKEN_ADDRESS, //SOL
      outputToken: TO_TOKEN_ADDRESS, //USDC
      chain: NetworkId.solana, //Solana
      amountIn: AMOUNT_IN,
      slippage: SLIPPAGE_PERCENTAGE, //0.5%
      sender: solanaSigner.publicKey.toString(), //sender address
    },
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": "//* YOUR API KEY *//",
    },
  });
  const data = {
    quote: response.data?.data[0],
    address: solanaSigner.publicKey.toBase58(),
    recipient: RECIPIENT_ADDRESS,
  };
  console.log("kanaswap Solana Quote::",data.quote);
  try {
    const response = await axios.post(
      "https://ag.kanalabs.io/v1/swapInstruction",
      data
    );
    const decodedTransaction = Buffer.from(
      response.data?.data?.swapTransaction,
      "base64"
    );
    const transaction = VersionedTransaction.deserialize(decodedTransaction);
    transaction.message.recentBlockhash = (
      await solanaProvider.getLatestBlockhash("confirmed")
    ).blockhash;
    transaction.sign([solanaSigner]);
    const submittedTransaction = await sendSolanaTransaction(
      solanaProvider,
      transaction
    );
    console.log(`Submitted transaction hash: ${submittedTransaction}`);
  } catch (error) {
    console.error("Error posting swap instruction:", error);
    throw error;
  }
};

kanaswap();
