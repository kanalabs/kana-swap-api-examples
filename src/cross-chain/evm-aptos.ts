/**
 * Polygon (POL/MATIC) → Aptos (APT)
 */

import axios from "axios";
import "dotenv/config";

import {
  Aptos,
  AptosConfig,
  Ed25519Account,
  Ed25519PrivateKey,
  Network,
  PrivateKey,
  PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";

import { ethers } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";

import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // POL / MATIC
const TARGET_TOKEN = "0x1::aptos_coin::AptosCoin"; // APT

const AMOUNT_IN = "1000000000000000000"; // 1 POL
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ----------------------------- POLYGON SETUP ------------------------------ */

const polygonProvider = new ethers.providers.JsonRpcProvider(
  process.env.POLYGON_RPC_URL!
);

const polygonSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  polygonProvider
);

/* ------------------------------ APTOS SETUP ------------------------------- */

const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));

const aptosAccount = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(
    PrivateKey.formatPrivateKey(
      process.env.APTOS_PRIVATE_KEY!,
      PrivateKeyVariants.Ed25519
    )
  ),
});

/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                  */
/* -------------------------------------------------------------------------- */

async function polygonToAptosSwap() {
  console.log("🚀 Starting Flow: POL (Polygon) -> APT (Aptos)");
  console.log(`👤 Polygon User: ${await polygonSigner.getAddress()}`);
  console.log(`👤 Aptos User: ${aptosAccount.accountAddress.toString()}`);

  /* ----------------------------- 1. QUOTE -------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.polygon,
      targetChain: NetworkId.aptos,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log(`✅ Quote fetched. Est Output: ${quote.outAmount}`);

  /* -------------------- 2. BUILD SOURCE INSTRUCTIONS ---------------------- */
  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: await polygonSigner.getAddress(),
      targetAddress: aptosAccount.accountAddress.toString(),
    },
    { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  /* -------------------- 3. EXECUTE SWAP & BURN ON EVM --------------------- */
  const burnTxHash = await executeEvmInstruction(
    polygonSigner,
    instruction
  );

  console.log("🔥 Atomic Swap & Burn executed on Polygon:", burnTxHash);

  /* -------------------- 4. WAIT FOR CCTP ATTESTATION ---------------------- */
  console.log("⏳ Polling for CCTP Attestation...");
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.polygon,
      txHash: burnTxHash,
    });

  console.log("🟢 CCTP Attestation Ready");

  /* -------------------- 5. CLAIM (MINT USDC ON APTOS) --------------------- */
  console.log("📥 Claiming USDC on Aptos...");
  
  const claimRes = await callClaimWithRetry({
    quote,
    targetAddress: aptosAccount.accountAddress.toString(),
    messageBytes,
    attestationSignature,
  });

  const claimPayload = claimRes.data.data.claimPayload;
  
  await executeAptosInstruction(
    aptos,
    aptosAccount,
    claimPayload
  );

  console.log("🎉 USDC Minted on Aptos");

  /* -------------------- 6. TARGET SWAP (USDC -> APT) ---------------------- */
  if (quote.targetSwapRoute) {
    console.log("🔄 Step 3: Executing Target Swap (USDC -> APT)...");

    const swapInstructionRes = await axios.post(
      `${KANA_API_URL}/v1/swapInstruction`,
      {
        quote: quote.targetSwapRoute, 
        address: aptosAccount.accountAddress.toString(),
      },
      { headers }
    );

    const finalHash = await executeAptosInstruction(
      aptos,
      aptosAccount,
      swapInstructionRes.data.data
    );
    
    console.log("🚀 Final Swap Complete! Hash:", finalHash);
  } else {
    console.log("🏁 No target swap needed.");
  }
}

polygonToAptosSwap().catch(console.error);

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                    */
/* -------------------------------------------------------------------------- */

async function executeEvmInstruction(
  signer: ethers.Wallet,
  instruction: any
): Promise<string> {
  // 1. Handle Approve (if exists)
  if (instruction.approveIX) {
    const ix = instruction.approveIX;
    console.log("   -> Approving Token...");
    
    const tx = await signer.sendTransaction({
      from: ix.from,
      to: ix.to,
      data: ix.data,
      chainId: ix.chainId,
      gasPrice: BigNumber.from(ix.gasPrice).toHexString(),
      value: BigNumber.from(ix.value || 0).toHexString(),
    });
    
    await tx.wait();
  }

  // 2. Handle Transaction (Swap/Burn)
  const ix = instruction.transferIX;
  console.log("   -> Executing Transaction...");
  
  const tx = await signer.sendTransaction({
    from: ix.from,
    to: ix.to,
    data: ix.data,
    chainId: ix.chainId,
    gasPrice: BigNumber.from(ix.gasPrice).toHexString(),
    value: BigNumber.from(ix.value || 0).toHexString(),
  });

  const receipt = await tx.wait();
  return receipt.transactionHash;
}

function formatFunctionName(fn: string): `${string}::${string}::${string}` {
  return fn as `${string}::${string}::${string}`;
}

async function executeAptosInstruction(
  aptos: Aptos,
  signer: Ed25519Account,
  payload: any
): Promise<string> {
  
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress.toString(),
    data: {
      function: formatFunctionName(payload.function),
      typeArguments: payload.type_arguments,
      functionArguments: payload.arguments,
    },
  });

  const res = await aptos.signAndSubmitTransaction({
    signer,
    transaction: tx,
  });

  await aptos.waitForTransaction({
    transactionHash: res.hash,
    options: { checkSuccess: true },
  });

  return res.hash;
}

async function callClaimWithRetry(body: any) {
  while (true) {
    try {
      return await axios.post(`${KANA_API_URL}/v1/claim`, body, { headers });
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfter = Number(err.response.headers["retry-after"] ?? 5);
        console.log(`⏳ Rate limited. Retrying in ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
}

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

async function waitForAttestation(params: { sourceChain: NetworkId; txHash: string }) {
  const { sourceChain, txHash } = params;
  const pollIntervalMs = 5000;

  while(true) {
    try {
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
    } catch(e) {}
    
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}