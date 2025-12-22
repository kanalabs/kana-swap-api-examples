/**
 * Redeem flow: Solana → Aptos
 */
import axios from "axios";
import "dotenv/config";
import { Aptos, AptosConfig, Network, Ed25519Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";

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

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";
const BRIDGE_ID_CCTP = 3;

// CCTP Map
const CCTP_CHAIN_MAP: Record<number, number> = {
  [NetworkId.solana]: 5, [NetworkId.aptos]: 9
};

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
const SOLANA_BURN_TX_HASH = process.env.SOLANA_BURN_TX_HASH!;
if (!SOLANA_BURN_TX_HASH) throw new Error("Missing SOLANA_BURN_TX_HASH");

const headers = { "Content-Type": "application/json", "X-API-KEY": process.env.XYRA_API_KEY! };

// Aptos Setup
const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));
const aptosAccount = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(PrivateKey.formatPrivateKey(process.env.APTOS_PRIVATE_KEY!, PrivateKeyVariants.Ed25519)),
});

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */
async function redeemSolanaToAptos() {
  console.log("🚀 Starting Redeem: Solana -> Aptos");
  console.log("🔹 Burn Hash:", SOLANA_BURN_TX_HASH);

  // 1. Wait for Attestation
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } = await waitForAttestation(NetworkId.solana, SOLANA_BURN_TX_HASH);
  console.log("🟢 CCTP attestation ready!");

  // 2. Build Redeem
  console.log("🛠️ Building redeem transaction via API...");
  try {
    const res = await axios.post(`${KANA_API_URL}/v1/redeem`, {
      sourceChainID: NetworkId.solana,
      targetChainID: NetworkId.aptos,
      bridgeID: BRIDGE_ID_CCTP,
      targetAddress: aptosAccount.accountAddress.toString(),
      messageBytes,
      attestationSignature,
    }, { headers });

    const responseData = res.data;
    const dataBlock = responseData.data?.[0] || responseData.data || responseData;

    if (!dataBlock) throw new Error("API returned empty data.");

    const payload = dataBlock.claimPayload || dataBlock.claimIx || dataBlock.redeemIx || dataBlock.payload || dataBlock.transaction;
    
    if (!payload) {
        throw new Error(`Missing Aptos payload. Available keys: ${Object.keys(dataBlock).join(", ")}`);
    }

    console.log("✅ Redeem instruction received");

    // 3. Execute
    console.log("📤 Submitting to Aptos...");
    
    const transaction = await aptos.transaction.build.simple({
      sender: aptosAccount.accountAddress,
      data: {
        function: payload.function,
        typeArguments: payload.type_arguments,
        functionArguments: payload.arguments,
      },
    });

    const pendingTx = await aptos.signAndSubmitTransaction({ signer: aptosAccount, transaction });
    console.log("⏳ Tx Submitted:", pendingTx.hash);
    
    await aptos.waitForTransaction({ transactionHash: pendingTx.hash });
    console.log("🎉 Success! Redeemed on Aptos.");

  } catch (error: any) {
    if (error.response) {
        console.error("❌ API Error:", JSON.stringify(error.response.data, null, 2));
    } else {
        console.error("❌ Error:", error.message);
    }
  }
}

redeemSolanaToAptos().catch(console.error);

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