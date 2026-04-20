/**
 * Redeem flow: Aptos → Solana
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

import { KANA_API_URL, NetworkId } from "../../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const APTOS_BURN_TX_HASH = process.env.APTOS_BURN_TX_HASH!;

if (!APTOS_BURN_TX_HASH) {
    throw new Error("❌ Missing APTOS_BURN_TX_HASH in .env");
}

const BRIDGE_ID_CCTP = 3; 

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ---------------------------- SOLANA SETUP -------------------------------- */

const solanaConnection = new Connection(
  process.env.SOLANA_RPC_URL || clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const solanaSigner = Keypair.fromSecretKey(
  bs58.decode(process.env.SOLANA_PRIVATE_KEY!)
);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function redeemAptosToSolana() {
  console.log("🚀 Starting Redeem: Aptos -> Solana");
  console.log("🔹 Burn Hash:", APTOS_BURN_TX_HASH);
  console.log(`👤 Target Solana User: ${solanaSigner.publicKey.toBase58()}`);

  /* -------------------- 1. WAIT FOR ATTESTATION --------------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  
  const { messageBytes, attestationSignature } = await waitForAttestation(
    NetworkId.aptos, 
    APTOS_BURN_TX_HASH
  );
  console.log("🟢 CCTP Attestation Ready!");

  /* -------------------- 2. BUILD REDEEM TRANSACTION ----------------------- */
  console.log("🛠️ Fetching redeem instruction from API...");
  
  try {
    const res = await axios.post(`${KANA_API_URL}/v1/redeem`, {
      sourceChainID: NetworkId.aptos,
      targetChainID: NetworkId.solana, 
      bridgeID: BRIDGE_ID_CCTP,
      targetAddress: solanaSigner.publicKey.toBase58(),
      messageBytes: [messageBytes], 
      attestationSignature: [attestationSignature], 
    }, { headers });

    const redeemData = res.data.data;
    
    const solanaTxBase64 = redeemData.claimIx || redeemData.transaction || redeemData;

    if (!solanaTxBase64 || typeof solanaTxBase64 !== 'string') {
        console.error("❌ Invalid response:", redeemData);
        throw new Error("API did not return a valid Solana transaction string.");
    }

    console.log("✅ Redeem instruction built");

    /* -------------------- 3. EXECUTE ON SOLANA ---------------------------- */
    console.log("📤 Submitting Redeem Transaction to Solana...");

    const tx = VersionedTransaction.deserialize(Buffer.from(solanaTxBase64, "base64"));
    tx.sign([solanaSigner]);

    const mintTxHash = await sendSolanaTransaction(solanaConnection, tx);

    console.log("🎉 Success! Redeem confirmed on Solana.");
    console.log("🔗 Tx Hash:", mintTxHash);

  } catch (e: any) {
      if (e.response) {
          console.error("❌ API Error:", JSON.stringify(e.response.data, null, 2));
      } else {
          console.error("❌ Error:", e.message);
      }
  }
}

redeemAptosToSolana().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

export const sendSolanaTransaction = async (
  provider: Connection,
  transaction: VersionedTransaction
): Promise<string> => {
  const serializedTx = transaction.serialize();
  const blockhash = transaction.message.recentBlockhash as string;
  let attempt = 0;
  let signature: string | null = null;

  while (attempt < 5) {
    attempt++;
    try {
      if (signature) {
        const status = await provider.getSignatureStatus(signature, { searchTransactionHistory: true });
        if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
          return signature;
        }
      }

      if (!signature || (attempt > 1)) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 2000));
        
        signature = await provider.sendRawTransaction(serializedTx, {
          maxRetries: 0, 
          preflightCommitment: "confirmed",
          skipPreflight: true, 
        });

        try {
          await Promise.race([
            provider.confirmTransaction(
              { signature, blockhash, lastValidBlockHeight: 0 },
              "confirmed"
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
          ]);
          return signature;
        } catch (e) { }
      }
    } catch (error: any) {
      console.log(`   -> Attempt ${attempt} failed: ${error.message}`);
      if (error.message.includes("0x1")) { 
          // If 0x1 (insufficient funds) happens, it likely means the claim was already processed
          throw new Error("Transaction failed (0x1). Check if already redeemed.");
      }
      signature = null;
    }
  }

  throw new Error(`Failed to send transaction after ${5} attempts`);
};

/* ---------------------- CCTP ATTESTATION POLLING -------------------------- */

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";

const CHAIN_TO_CCTP_ID: Record<number, number> = {
  [NetworkId.ethereum]: 0,
  [NetworkId.Avalanche]: 1,
  [NetworkId.Arbitrum]: 3,
  [NetworkId.solana]: 5,
  [NetworkId.base]: 6,
  [NetworkId.polygon]: 7,
  [NetworkId.sui]: 8,
  [NetworkId.aptos]: 9,
};

async function waitForAttestation(sourceChain: number, txHash: string) {
  const pollInterval = 5000; 
  
  while (true) {
    try {
      const url = `${CIRCLE_ATTESTATION_API}/messages/${CHAIN_TO_CCTP_ID[sourceChain]}/${txHash}`;
      const res = await fetch(url);
      
      if (res.ok) {
        const json = await res.json();
        const msg = json?.messages?.[0];
        
        if (msg && msg.attestation !== 'PENDING') {
          return { 
            messageBytes: msg.message, 
            attestationSignature: msg.attestation 
          };
        }
      }
    } catch (e) {}
    
    process.stdout.write(".");
    await new Promise(r => setTimeout(r, pollInterval));
  }
}