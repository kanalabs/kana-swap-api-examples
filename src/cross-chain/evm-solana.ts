/**
 * Avalanche (USDC) → Solana (USDC) via CCTP
 * Approve → Burn → Attestation → Claim → Mint
 */

import axios from "axios";
import "dotenv/config";

import { ethers } from "ethers";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import bs58 from "bs58";

import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */

// Avalanche USDC
const SOURCE_TOKEN = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";

// Solana USDC
const TARGET_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 0.1 USDC (USDC = 6 decimals)
const AMOUNT_IN = "100000";
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* --------------------------- AVALANCHE SETUP ------------------------------ */

const avaxProvider = new ethers.providers.JsonRpcProvider(
  process.env.AVALANCHE_RPC_URL!
);

const avaxSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  avaxProvider
);

/* ----------------------------- SOLANA SETUP ------------------------------- */

const solanaConnection = new Connection(
  clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

/* -------------------------------------------------------------------------- */
/*                                   FLOW                                     */
/* -------------------------------------------------------------------------- */

async function avalancheToSolanaSwap() {
  /* --------------------------- 1. QUOTE ---------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.Avalanche,
      targetChain: NetworkId.solana,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* ------------------ 2. BUILD INSTRUCTIONS ------------------------------- */
  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: await avaxSigner.getAddress(),
      targetAddress: solanaSigner.publicKey.toBase58(),
    },
    { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  /* ------------------ 3a. APPROVE USDC ------------------------------------ */
  if (instruction.approveIX) {
    const approveTx = await avaxSigner.sendTransaction({
      to: instruction.approveIX.to,
      data: instruction.approveIX.data,
      value: instruction.approveIX.value,
    });
    await approveTx.wait();
    console.log("✅ USDC allowance approved");
  }

  /* ------------------ 3b. BURN (CCTP) ------------------------------------- */
  const burnTx = await avaxSigner.sendTransaction({
    to: instruction.transferIX.to,
    data: instruction.transferIX.data,
    value: instruction.transferIX.value,
  });

  const burnReceipt = await burnTx.wait();
  const burnHash = burnReceipt.transactionHash;

  console.log("🔥 Burn executed on Avalanche:", burnHash);

  /* ------------------ 4. WAIT FOR ATTESTATION ----------------------------- */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.Avalanche,
      txHash: burnHash,
    });

  console.log("🟢 CCTP attestation ready");

  /* ------------------ 5. CLAIM (SOLANA) ----------------------------------- */
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote,
      targetAddress: solanaSigner.publicKey.toBase58(),
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  const claimIx = claimRes.data.data.claimIx;
  console.log("✅ Claim instruction received");

  /* ------------------ 6. EXECUTE ON SOLANA -------------------------------- */
  const sig = await executeSolanaTx(
    solanaConnection,
    solanaSigner,
    claimIx
  );

  console.log("🎉 USDC minted on Solana:", sig);
}

avalancheToSolanaSwap();

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
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
    { signature: sig, blockhash, lastValidBlockHeight },
    "finalized"
  );

  return sig;
}

/* ---------------------- CCTP ATTESTATION ---------------------------------- */

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CHAIN_TO_CCTP_ID: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
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
