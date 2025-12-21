import axios from "axios";
import "dotenv/config";
import bs58 from "bs58";

import {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  getTransactionDecoder,
  type KeyPairSigner,
  type Base64EncodedWireTransaction,
} from "@solana/kit";

import { Keypair, VersionedTransaction } from "@solana/web3.js";

import { KANA_API_URL, NetworkId } from "../../constant";

const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!; // Your Solana private key in base58 format
const FROM_TOKEN_ADDRESS = "So11111111111111111111111111111111111111112";
const TO_TOKEN_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const AMOUNT_IN = 10_000_000;
const SLIPPAGE_PERCENTAGE = 0.5;

const RPC_ENDPOINT =
  process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

const rpc = createSolanaRpc(RPC_ENDPOINT);

let signer: KeyPairSigner;

async function sendAndConfirmTransaction(
  serializedTx: Base64EncodedWireTransaction,
  lastValidBlockHeight: bigint
): Promise<string> {
  const signature = await rpc
    .sendTransaction(serializedTx, {
      skipPreflight: true,
      maxRetries: BigInt(0),
      encoding: "base64",
    })
    .send();

  console.log(`📤 Transaction sent: ${signature}`);

  const abortController = new AbortController();

  const resender = async () => {
    while (!abortController.signal.aborted) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await rpc
          .sendTransaction(serializedTx, {
            skipPreflight: true,
            maxRetries: BigInt(0),
            encoding: "base64",
          })
          .send();
      } catch {}
    }
  };

  const resendPromise = resender();

  try {
    while (true) {
      const { value } = await rpc
        .getSignatureStatuses([signature])
        .send();

      const status = value[0];

      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        console.log(`✅ Transaction confirmed: ${signature}`);
        break;
      }

      if (status?.err) {
        throw new Error(
          `Transaction failed: ${JSON.stringify(status.err)}`
        );
      }

      if (
        status?.slot &&
        BigInt(status.slot) > lastValidBlockHeight
      ) {
        throw new Error("❌ Transaction expired");
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    abortController.abort();
    await resendPromise.catch(() => {});
    return signature;
  } catch (err) {
    abortController.abort();
    await resendPromise.catch(() => {});
    throw err;
  }
}

export const kanaswap = async () => {
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: FROM_TOKEN_ADDRESS,
      outputToken: TO_TOKEN_ADDRESS,
      chain: NetworkId.solana,
      amountIn: AMOUNT_IN,
      slippage: SLIPPAGE_PERCENTAGE,
      sender: signer.address,
    },
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.XYRA_API_KEY!,
    },
  });

  const quote = quoteRes.data?.data?.[0];
  if (!quote) throw new Error("No quote returned");

const instrRes = await axios.post(
  `${KANA_API_URL}/v1/swapInstruction`,
  {
    quote,
    address: signer.address,
  },
  {
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.XYRA_API_KEY!,
    },
  }
);

  const swapTxBase64 = instrRes.data?.data?.swapTransaction;
  if (!swapTxBase64) throw new Error("No swap transaction received");

  const { value } = await rpc.getLatestBlockhash().send();

  // Convert base58 secret into web3.js Keypair
  const secretBytes = bs58.decode(SOLANA_PRIVATE_KEY);
  const legacyKeypair = Keypair.fromSecretKey(secretBytes);

  const wireTx = VersionedTransaction.deserialize(
    Buffer.from(swapTxBase64, "base64")
  );

  // Sign with web3.js keypair as its currently not supported in solana-kit
  wireTx.sign([legacyKeypair]);

  const serializedTx = Buffer.from(wireTx.serialize()).toString(
    "base64"
  ) as Base64EncodedWireTransaction;

  console.log("🚀 Sending transaction...");

  const signature = await sendAndConfirmTransaction(
    serializedTx,
    value.lastValidBlockHeight
  );

  console.log(`🔗 https://solscan.io/tx/${signature}`);
  return signature;
};

(async () => {
  try {
    signer = await createKeyPairSignerFromBytes(
      bs58.decode(SOLANA_PRIVATE_KEY)
    );
    await kanaswap();
  } catch (e) {
    console.error(e);
  }
})();
