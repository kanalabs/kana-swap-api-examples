/**
 * Redeem flow: Aptos → Polygon (EVM)
 */

import axios from "axios";
import "dotenv/config";
import { ethers, BigNumber } from "ethers";

import { KANA_API_URL, NetworkId } from "../../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const APTOS_BURN_TX_HASH = process.env.APTOS_BURN_TX_HASH!;

const TARGET_CHAIN_ID = NetworkId.polygon; 

if (!APTOS_BURN_TX_HASH) {
    throw new Error("❌ Missing APTOS_BURN_TX_HASH in .env");
}

const BRIDGE_ID_CCTP = 3; 

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ----------------------------- EVM SETUP ---------------------------------- */

const evmProvider = new ethers.providers.JsonRpcProvider(
  process.env.POLYGON_RPC_URL || "https://polygon-rpc.com"
);

const evmSigner = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, evmProvider);

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function redeemAptosToPolygon() {
  console.log("🚀 Starting Redeem: Aptos -> Polygon");
  console.log(`🔹 Target Chain: ${NetworkId[TARGET_CHAIN_ID]}`);
  console.log("🔹 Burn Hash:", APTOS_BURN_TX_HASH);
  console.log(`👤 Target Polygon User: ${await evmSigner.getAddress()}`);

  /* -------------------- 1. WAIT FOR ATTESTATION --------------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  
  const { messageBytes, attestationSignature } = await waitForAttestation(
    NetworkId.aptos, 
    APTOS_BURN_TX_HASH
  );
  console.log("🟢 CCTP Attestation Ready!");

  /* -------------------- 2. BUILD REDEEM PAYLOAD --------------------------- */
  console.log("🛠️ Fetching redeem instruction from API...");
  
  try {
    const res = await axios.post(`${KANA_API_URL}/v1/redeem`, {
      sourceChainID: NetworkId.aptos,
      targetChainID: TARGET_CHAIN_ID, 
      bridgeID: BRIDGE_ID_CCTP,
      targetAddress: await evmSigner.getAddress(),
      messageBytes: [messageBytes], 
      attestationSignature: [attestationSignature], 
    }, { headers });

    const redeemData = res.data.data;
    
    const txPayload = redeemData.claimIx || redeemData;

    if (!txPayload || !txPayload.to || !txPayload.data) {
        console.error("❌ Invalid response:", redeemData);
        throw new Error("API did not return a valid EVM transaction payload.");
    }

    console.log("✅ Redeem instruction built");

    /* -------------------- 3. EXECUTE ON POLYGON --------------------------- */
    console.log("📤 Submitting Redeem Transaction to Polygon...");

    const txResponse = await evmSigner.sendTransaction({
      from: txPayload.from, 
      to: txPayload.to,
      data: txPayload.data,
      chainId: txPayload.chainId,
      gasPrice: txPayload.gasPrice ? BigNumber.from(txPayload.gasPrice).toHexString() : undefined,
      value: BigNumber.from(txPayload.value || "0").toHexString()
    });

    console.log("⏳ Transaction sent:", txResponse.hash);
    
    const receipt = await txResponse.wait();
    console.log("🎉 Success! Redeem confirmed in block:", receipt.blockNumber);

  } catch (e: any) {
      if (e.response) {
          console.error("❌ API Error:", JSON.stringify(e.response.data, null, 2));
      } else {
          console.error("❌ Error:", e.message);
      }
  }
}

redeemAptosToPolygon().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

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