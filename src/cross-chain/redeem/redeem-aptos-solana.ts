/**
 * Redeem flow: Aptos → Solana (USDC)
 * Burn (already done) → Attestation → Redeem → Mint on Solana
 */

import axios from "axios";
import "dotenv/config";

import {
  Connection,
  Keypair,
  VersionedTransaction,
  clusterApiUrl,
} from "@solana/web3.js";

import bs58 from "bs58";

const KANA_API_URL = "https://ag.kanalabs.io";

enum NetworkId {
  solana = 1,
  aptos = 2,
  polygon = 3,
  bsc = 4,
  sui = 5,
  ethereum = 6,
  base = 7,
  zkSync = 9,
  Avalanche = 10,
  Arbitrum = 11,
}

const BRIDGE_ID_CCTP = 3; 

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CCTP_CHAIN_MAP: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.sui]: 8,
  [NetworkId.aptos]: 9, 
};

/* -------------------------------------------------------------------------- */
/* CONFIG                                   */
/* -------------------------------------------------------------------------- */

const APTOS_BURN_TX_HASH = process.env.APTOS_BURN_TX_HASH!;

if (!APTOS_BURN_TX_HASH) {
  throw new Error("❌ Missing process.env.APTOS_BURN_TX_HASH");
}

if (!process.env.SOLANA_PRIVATE_KEY) {
  throw new Error("❌ Missing process.env.SOLANA_PRIVATE_KEY");
}

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* -------------------------------------------------------------------------- */
/* SOLANA SETUP                                */
/* -------------------------------------------------------------------------- */

const solanaConnection = new Connection(
  process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

/* -------------------------------------------------------------------------- */
/* FLOW                                     */
/* -------------------------------------------------------------------------- */

async function redeemAptosToSolana() {
  console.log("🚀 Starting Redeem Flow: Aptos -> Solana");
  console.log("🔹 Burn Hash:", APTOS_BURN_TX_HASH);
  console.log("🔹 Target Address:", solanaSigner.publicKey.toBase58());

  /* ---------------------- 1. WAIT FOR ATTESTATION ------------------------ */
  console.log("⏳ Polling for CCTP Attestation...");
  
  const { messageBytes, attestationSignature } =
    await waitForAttestation(
      NetworkId.aptos,
      APTOS_BURN_TX_HASH
    );

  console.log("🟢 CCTP attestation ready!");

  /* ---------------------- 2. BUILD REDEEM TX ----------------------------- */
  console.log("🛠️ Building redeem transaction via API...");
  
  try {
    const redeemRes = await axios.post(
      `${KANA_API_URL}/v1/redeem`,
      {
        sourceChainID: NetworkId.aptos,
        targetChainID: NetworkId.solana,
        bridgeID: BRIDGE_ID_CCTP, 
        targetAddress: solanaSigner.publicKey.toBase58(),
        messageBytes,
        attestationSignature,
      },
      { headers }
    );

    const responseData = redeemRes.data;
    const dataBlock = responseData.data?.[0] || responseData.data || responseData;

    if (!dataBlock) {
       throw new Error("API returned empty data block.");
    }

    const redeemTxBase64 = dataBlock.claimIx || dataBlock.redeemIx || dataBlock.transaction || dataBlock.tx || dataBlock.payload;
    
    if (!redeemTxBase64) {
      throw new Error(`Could not find transaction string. Keys found: ${Object.keys(dataBlock).join(", ")}`);
    }

    console.log("✅ Redeem transaction found");

    /* ---------------------- 3. EXECUTE ON SOLANA --------------------------- */
    console.log("📤 Submitting to Solana...");
    
    const sig = await executeSolanaTx(
      solanaConnection,
      solanaSigner,
      redeemTxBase64
    );

    console.log("🎉 Success! USDC minted on Solana.");
    console.log(`🔗 Explorer: https://solscan.io/tx/${sig}`);

  } catch (error: any) {
    if (error.response) {
        console.error("❌ API Error Status:", error.response.status);
        console.error("❌ API Error Data:", JSON.stringify(error.response.data, null, 2));
    } else {
        console.error("❌ Error:", error.message);
    }
  }
}

redeemAptosToSolana().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                   */
/* -------------------------------------------------------------------------- */

async function executeSolanaTx(
  connection: Connection,
  signer: Keypair,
  base64Tx: string
): Promise<string> {
  // 1. Deserialize
  const txBuffer = Buffer.from(base64Tx, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);

  // 2. Sign
  tx.sign([signer]);

  // 3. Send
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  console.log("⏳ Transaction sent:", signature);

  // 4. Confirm
  const latestBlockhash = await connection.getLatestBlockhash();

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    "finalized"
  );

  return signature;
}

/* ---------------------- CCTP ATTESTATION POLLING -------------------------- */

async function waitForAttestation(
  chain: NetworkId,
  txHash: string
) {
  const pollIntervalMs = 5000; 
  const maxRetries = 120; 
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const url = `${CIRCLE_ATTESTATION_API}/messages/${CCTP_CHAIN_MAP[chain]}/${txHash}`;
      const res = await fetch(url);
      
      if (res.ok) {
        const json = await res.json();
        const msg = json?.messages?.[0];

        if (msg && msg.attestation !== "PENDING") {
          return {
            messageBytes: msg.message,
            attestationSignature: msg.attestation,
          };
        }
      }
    } catch (e) {
      // Ignore network errors
    }

    retries++;
    if (retries % 6 === 0) console.log(`...still waiting for attestation (${retries}/${maxRetries})`);
    
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("❌ CCTP Attestation Timed Out");
}