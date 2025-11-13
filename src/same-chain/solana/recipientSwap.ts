import axios from "axios";
import "dotenv/config";
import {
  Keypair,
  Connection,
  VersionedTransaction,
  BlockhashWithExpiryBlockHeight,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { KANA_API_URL, NetworkId } from "../../constant";

// Constants
const SOLANA_PRIVATEKEY = "YOUR_SOLANA_PRIVATE_KEY";
const FROM_TOKEN_ADDRESS = "So11111111111111111111111111111111111111112";
const TO_TOKEN_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT_ADDRESS = "YOUR_RECIPIENT_ADDRESS";
const AMOUNT_IN = 10000000; // 0.01 SOL
const SLIPPAGE_PERCENTAGE = 0.5;
const RPC_ENDPOINT =
  process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

// Setup connection and signer
const solanaProvider = new Connection(RPC_ENDPOINT, "confirmed");
const solanaSigner = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATEKEY));

async function transactionSenderAndConfirmationWaiter(
  connection: Connection,
  serializedTransaction: Buffer,
  blockhashWithExpiryBlockHeight: BlockhashWithExpiryBlockHeight
): Promise<VersionedTransactionResponse | null> {
  const txid = await connection.sendRawTransaction(serializedTransaction, {
    skipPreflight: true,
    maxRetries: 0,
  });

  console.log(`📤 Transaction sent: ${txid}`);

  // Set up abort controller for the resender
  const controller = new AbortController();
  const abortSignal = controller.signal;

  // Resend transaction every 2 seconds until confirmed or expired
  const abortableResender = async () => {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (abortSignal.aborted) return;

      try {
        await connection.sendRawTransaction(serializedTransaction, {
          skipPreflight: true,
          maxRetries: 0,
        });
        console.log("🔄 Transaction resent");
      } catch (error: any) {
        // Ignore errors during resend
        console.log(`⚠️  Resend attempt failed: ${error.message}`);
      }
    }
  };

  // Start the resender in background
  const resenderPromise = abortableResender();

  try {
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(
      {
        signature: txid,
        blockhash: blockhashWithExpiryBlockHeight.blockhash,
        lastValidBlockHeight:
          blockhashWithExpiryBlockHeight.lastValidBlockHeight,
      },
      "confirmed"
    );

    // Stop the resender
    controller.abort();
    await resenderPromise.catch(() => {}); // Ignore abort errors

    if (confirmation.value.err) {
      console.error("❌ Transaction failed:", confirmation.value.err);
      throw new Error(
        `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    console.log(`✅ Transaction confirmed: ${txid}`);

    // Fetch the transaction details (with retries for RPC sync)
    let retries = 15;
    while (retries > 0) {
      const response = await connection.getTransaction(txid, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (response) {
        return response;
      }

      // RPC might not be synced yet, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 1000));
      retries--;
    }

    console.warn("⚠️  Transaction confirmed but details not yet available");
    return null;
  } catch (error: any) {
    // Stop the resender
    controller.abort();
    await resenderPromise.catch(() => {});

    if (error.name === "TransactionExpiredBlockheightExceededError") {
      console.error("❌ Transaction expired - blockhash is too old");
    }

    throw error;
  }
}
export const kanaswap = async () => {
  const response = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
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
    recipient: RECIPIENT_ADDRESS
  };
  try {
    const response = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      data
    );

    const swapTransactionBase64 = response.data?.data?.swapTransaction;
    if (!swapTransactionBase64) {
      throw new Error("No swap transaction received from Kana");
    }

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransactionBase64, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    console.log("📝 Transaction deserialized");

    // Get fresh blockhash (critical for confirmation)
    const blockhashWithExpiryBlockHeight =
      await solanaProvider.getLatestBlockhash("confirmed");

    // Update transaction with fresh blockhash
    transaction.message.recentBlockhash =
      blockhashWithExpiryBlockHeight.blockhash;

    console.log("🔑 Signing transaction...");

    // Sign the transaction
    transaction.sign([solanaSigner]);

    // Send and confirm with Jupiter pattern
    console.log("🚀 Sending transaction...");
    const serializedTransaction = Buffer.from(transaction.serialize());

    const result = await transactionSenderAndConfirmationWaiter(
      solanaProvider,
      serializedTransaction,
      blockhashWithExpiryBlockHeight
    );

    if (!result) {
      console.warn("⚠️  Transaction confirmed but details unavailable");
    } else if (result.meta?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(result.meta.err)}`);
    }

    const signature = bs58.encode(transaction.signatures[0]);

    console.log("\n✨ Swap completed successfully!");
    console.log(`🔗 View on Solscan: https://solscan.io/tx/${signature}`);

    return signature;
  } catch (error) {
    console.error("Error posting swap instruction:", error);
    throw error;
  }
};

kanaswap();
