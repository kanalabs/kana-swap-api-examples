/**
 * Example: Solana → Avalanche (USDC) cross-chain swap
 * Burn → Attestation → Claim → Mint
 */

import axios from "axios";
import "dotenv/config";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";

import { ethers } from "ethers";
import bs58 from "bs58";

import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/*                                  CONFIG                                    */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const TARGET_TOKEN =
  "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"; // USDC (Avalanche)

const AMOUNT_IN = "100000";
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ---------------------------- SOLANA SETUP -------------------------------- */

const solanaConnection = new Connection(
  clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

/* --------------------------- AVALANCHE SETUP ------------------------------ */

const avaxProvider = new ethers.providers.JsonRpcProvider(
  process.env.AVALANCHE_RPC_URL!
);

const avaxSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  avaxProvider
);

/* -------------------------------------------------------------------------- */
/*                                  MAIN FLOW                                 */
/* -------------------------------------------------------------------------- */

async function solanaToAvalancheSwap() {
  /* --------------------------- 1. QUOTE ---------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.solana,
      targetChain: NetworkId.Avalanche,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* ------------------ 2. BUILD SOURCE INSTRUCTIONS ------------------------ */
  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: solanaSigner.publicKey.toBase58(),
      targetAddress: await avaxSigner.getAddress(),
    },
    { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  /* ------------------ 3. EXECUTE ON SOLANA (BURN) ------------------------- */
  const solanaTxHash = await executeSolanaTx(
    solanaConnection,
    solanaSigner,
    instruction.transferTx
  );

  console.log("🔥 Burn executed on Solana:", solanaTxHash);

  /* ------------------ 4. WAIT FOR CCTP ATTESTATION ------------------------ */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.solana,
      txHash: solanaTxHash,
    });

  console.log("🟢 CCTP attestation ready");

  /* ------------------ 5. CLAIM (HAPPY FLOW) ------------------------------- */
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote,
      targetAddress: await avaxSigner.getAddress(),
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  const claimIx = claimRes.data.data.claimIx;
  console.log("✅ Claim instruction received");

  /* ------------------ 6. EXECUTE ON AVALANCHE (MINT) ---------------------- */
  const tx = await avaxSigner.sendTransaction({
    to: claimIx.to,
    data: claimIx.data,
    value: BigInt(claimIx.value),
  });

  const receipt = await tx.wait();
  console.log("🎉 USDC minted on Avalanche:", receipt!.transactionHash);
}

solanaToAvalancheSwap();

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */

async function executeSolanaTx(
  connection: Connection,
  signer: Keypair,
  base64Tx: string
): Promise<string> {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(base64Tx, "base64")
  );

  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash,
      lastValidBlockHeight,
    },
    "finalized"
  );

  return sig;
}

/* ---------------------- CCTP ATTESTATION POLLING -------------------------- */

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CHAIN_TO_CCTP_ID: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.aptos]: 9,
};

async function waitForAttestation(params: {
  sourceChain: NetworkId;
  txHash: string;
}) {
  const { sourceChain, txHash } = params;

  while (true) {
    const url = `${CIRCLE_ATTESTATION_API}/messages/${CHAIN_TO_CCTP_ID[sourceChain]}/${txHash}`;
    const res = await fetch(url);
    const json = await res.json();

    const msg = json?.messages?.[0];
    if (msg && msg.attestation !== "PENDING") {
      return {
        messageBytes: msg.message,
        attestationSignature: msg.attestation,
      };
    }

    await new Promise((r) => setTimeout(r, 4000));
  }
}
