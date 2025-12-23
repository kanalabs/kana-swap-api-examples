/**
 * Redeem flow: Aptos → EVM (Ethereum)
 */
import axios from "axios";
import "dotenv/config";
import { ethers } from "ethers";

const KANA_API_URL = "https://ag.kanalabs.io";

const CIRCLE_ATTESTATION_API = "https://iris-api.circle.com";
const BRIDGE_ID_CCTP = 3;

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

const APTOS_BURN_TX_HASH = process.env.APTOS_BURN_TX_HASH!;
if (!APTOS_BURN_TX_HASH) throw new Error("Missing APTOS_BURN_TX_HASH");

if (!process.env.EVM_PRIVATE_KEY) throw new Error("Missing EVM_PRIVATE_KEY");

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

const ETHEREUM_RPC_URL = "https://ethereum.blockpi.network/v1/rpc/df30afe448c2c21888f1c276340c62f45890ed8c";

const evmProvider = new ethers.providers.JsonRpcProvider(ETHEREUM_RPC_URL);
const evmSigner = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, evmProvider);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */
async function redeemAptosToEvm() {
  console.log("🚀 Starting Redeem: Aptos -> EVM");
  console.log("🔹 Burn Hash:", APTOS_BURN_TX_HASH);

  // 1. Wait for CCTP Attestation
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } = await waitForAttestation(
    NetworkId.aptos, 
    APTOS_BURN_TX_HASH
  );
  console.log("🟢 CCTP attestation ready!");

  // 2. Build Redeem Transaction
  console.log("🛠️ Building redeem transaction...");
  try {
    const res = await axios.post(`${KANA_API_URL}/v1/redeem`, {
      sourceChainID: NetworkId.aptos,
      targetChainID: NetworkId.ethereum, // Target is Ethereum (Chain 6)
      bridgeID: BRIDGE_ID_CCTP,
      targetAddress: await evmSigner.getAddress(),
      messageBytes,
      attestationSignature,
    }, { headers });

    const dataBlock = res.data.data?.[0] || res.data.data || res.data;
    if (!dataBlock) throw new Error("API returned empty data.");

    const txPayload = dataBlock.claimIx || dataBlock.transaction || dataBlock.tx || dataBlock.payload || dataBlock.redeemIx;
    
    if (!txPayload) {
        throw new Error(`Missing transaction payload. Keys found: ${Object.keys(dataBlock).join(", ")}`);
    }

    console.log("✅ Redeem instruction received");

    // 3. Execute on EVM
    console.log("📤 Submitting to EVM...");
    
    // Safety check: ensure txPayload has required fields
    if (!txPayload.to || !txPayload.data) {
        throw new Error("Invalid transaction payload: missing 'to' or 'data'");
    }

    const txResponse = await evmSigner.sendTransaction({
      to: txPayload.to,
      data: txPayload.data,
      value: txPayload.value ? ethers.BigNumber.from(txPayload.value) : 0,
    });

    console.log("⏳ Transaction sent:", txResponse.hash);
    const receipt = await txResponse.wait();
    console.log("🎉 Success! Redeemed on EVM. Block:", receipt.blockNumber);

  } catch (error: any) {
    logError(error);
  }
}

redeemAptosToEvm().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */
async function waitForAttestation(chain: number, txHash: string) {
  const pollInterval = 5000;
  const maxRetries = 120; // 10 mins
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const url = `${CIRCLE_ATTESTATION_API}/messages/${CCTP_CHAIN_MAP[chain]}/${txHash}`;
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        const msg = json?.messages?.[0];
        if (msg && msg.attestation !== 'PENDING') {
          return { messageBytes: msg.message, attestationSignature: msg.attestation };
        }
      }
    } catch (e) {}
    
    retries++;
    if(retries % 6 === 0) console.log(`...waiting (${retries}/${maxRetries})`);
    await new Promise(r => setTimeout(r, pollInterval));
  }
  throw new Error("❌ CCTP Attestation Timed Out");
}

function logError(error: any) {
  if (error.response) {
    console.error("❌ API Error:", JSON.stringify(error.response.data, null, 2));
  } else if (error.code === 'NETWORK_ERROR') {
    console.error("❌ Network Error: Could not connect to RPC. Check internet or RPC URL.");
  } else {
    console.error("❌ Error:", error.message);
  }
}