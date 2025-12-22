/**
 * Redeem flow: EVM → Solana
 */
import axios from "axios";
import "dotenv/config";
import { Connection, Keypair, VersionedTransaction, clusterApiUrl } from "@solana/web3.js";
import bs58 from "bs58";

const KANA_API_URL = "https://ag.kanalabs.io";

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";
const BRIDGE_ID_CCTP = 3;

// Kana NetworkId Enum
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

// Full CCTP Domain Map for robustness
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
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
const EVM_BURN_TX_HASH = process.env.EVM_BURN_TX_HASH!;
if (!EVM_BURN_TX_HASH) throw new Error("Missing EVM_BURN_TX_HASH");

// Setup Solana
const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");
const signer = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY!));

const headers = { "Content-Type": "application/json", "X-API-KEY": process.env.XYRA_API_KEY! };

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */
async function redeemEvmToSolana() {
  console.log("🚀 Starting Redeem: EVM -> Solana");
  console.log("🔹 Burn Hash:", EVM_BURN_TX_HASH);
  
  // 1. Wait for Attestation
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } = await waitForAttestation(
    NetworkId.ethereum, // Or source chain ID
    EVM_BURN_TX_HASH
  );
  console.log("🟢 CCTP attestation ready!");

  // 2. Build Redeem
  console.log("🛠️ Building redeem transaction via API...");
  try {
    const res = await axios.post(`${KANA_API_URL}/v1/redeem`, {
      sourceChainID: NetworkId.ethereum,
      targetChainID: NetworkId.solana,
      bridgeID: BRIDGE_ID_CCTP,
      targetAddress: signer.publicKey.toBase58(),
      messageBytes,
      attestationSignature,
    }, { headers });

    const dataBlock = res.data.data?.[0] || res.data.data;
    if (!dataBlock) throw new Error("API returned empty data.");

    const txBase64 = dataBlock.redeemIx || dataBlock.transaction || dataBlock.claimIx || dataBlock.payload || dataBlock.claimPayload;
    
    if (!txBase64) {
      throw new Error(`Missing transaction string. Available keys: ${Object.keys(dataBlock).join(", ")}`);
    }

    console.log("✅ Redeem instruction received");

    // 3. Execute
    console.log("📤 Submitting to Solana...");
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
    tx.sign([signer]);
    
    const sig = await connection.sendRawTransaction(tx.serialize(), { 
        skipPreflight: false,
        maxRetries: 3 
    });
    console.log("⏳ Sent:", sig);
    
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ 
        signature: sig, 
        blockhash: latest.blockhash, 
        lastValidBlockHeight: latest.lastValidBlockHeight 
    }, "finalized");
    
    console.log("🎉 Success! Redeemed on Solana.");
    console.log(`🔗 Explorer: https://solscan.io/tx/${sig}`);

  } catch (error: any) {
    if (error.response) {
        console.error("❌ API Error:", JSON.stringify(error.response.data, null, 2));
    } else {
        console.error("❌ Error:", error.message);
    }
  }
}

redeemEvmToSolana().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */
async function waitForAttestation(chain: number, txHash: string) {
    const pollInterval = 5000; const maxRetries = 120; let retries = 0;
    while (retries < maxRetries) {
      try {
        const url = `${CIRCLE_ATTESTATION_API}/messages/${CCTP_CHAIN_MAP[chain]}/${txHash}`;
        const res = await fetch(url);
        if (res.ok) {
          const json = await res.json();
          const msg = json?.messages?.[0];
          if (msg && msg.attestation !== 'PENDING') return { messageBytes: msg.message, attestationSignature: msg.attestation };
        }
      } catch (e) {}
      retries++;
      if (retries % 6 === 0) console.log(`...still waiting (${retries}/${maxRetries})`);
      await new Promise(r => setTimeout(r, pollInterval));
    }
    throw new Error("❌ CCTP Attestation Timed Out");
}