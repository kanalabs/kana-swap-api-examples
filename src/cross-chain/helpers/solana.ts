import axios from "axios";
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import { KANA_API_URL, NetworkId } from "../../constant";

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ------------------ EXECUTE SOLANA TX ------------------ */

export async function executeSolanaInstruction(
  connection: Connection,
  signer: Keypair,
  base64Tx: string
): Promise<string> {
  const decoded = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(decoded);

  tx.message.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;

  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });

  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/* ------------------ SOLANA SWAP QUOTE ------------------ */

export async function getSolanaSwapQuote(params: {
  inputToken: string;
  outputToken: string;
  amountIn: string;
  slippage: number;
}) {
  const res = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      chain: NetworkId.solana,
      amountIn: params.amountIn,
      slippage: params.slippage,
    },
    headers,
  });

  return res.data.data[0];
}

/* ------------------ EXECUTE SOLANA SWAP ------------------ */

export async function executeSolanaSwap(params: {
  quote: any;
  connection: Connection;
  signer: Keypair;
}) {
  const res = await axios.post(
    `${KANA_API_URL}/v1/swapInstruction`,
    {
      quote: params.quote,
      address: params.signer.publicKey.toBase58(),
    },
    { headers }
  );

  const base64Tx = res.data?.data?.swapTransaction;
  if (!base64Tx) {
    throw new Error("Missing swapTransaction from Kana");
  }

  return executeSolanaInstruction(
    params.connection,
    params.signer,
    base64Tx
  );
}
