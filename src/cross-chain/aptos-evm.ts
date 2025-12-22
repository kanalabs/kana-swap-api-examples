/**
 * Example: Aptos → EVM cross-chain swap (FULL FLOW)
 * Burn → Attestation → Claim → Mint
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
/*                                CONFIG                                      */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0x1::aptos_coin::AptosCoin"; // APT
const TARGET_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // AVAX (EVM native)
const AMOUNT_IN = "1000000"; // 0.1 APT
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ----------------------------- APTOS SETUP -------------------------------- */

const aptos = new Aptos(
  new AptosConfig({ network: Network.MAINNET })
);

const aptosAccount = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(
    PrivateKey.formatPrivateKey(
      process.env.APTOS_PRIVATE_KEY!,
      PrivateKeyVariants.Ed25519
    )
  ),
});

/* ------------------------------ EVM SETUP --------------------------------- */

const evmProvider = new ethers.providers.JsonRpcProvider(
  process.env.AVALANCHE_RPC_URL!
);

const evmSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  evmProvider
);

/* -------------------------------------------------------------------------- */
/*                                MAIN FLOW                                   */
/* -------------------------------------------------------------------------- */

async function aptosToEvmSwap() {
  /* --------------------------- 1. QUOTE ---------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.aptos,
      targetChain: NetworkId.Avalanche,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* ---------------------- 2. BUILD SOURCE INSTRUCTIONS -------------------- */
  const instructionRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: aptosAccount.accountAddress.toString(),
      targetAddress: await evmSigner.getAddress(),
    },
    { headers }
  );

  const instruction = instructionRes.data.data;
  console.log("✅ Source instructions built");

  /* -------------------- 3. EXECUTE ON APTOS (BURN) ------------------------ */
  const aptosTxHash = await executeAptosInstruction(
    aptos,
    aptosAccount,
    instruction
  );

  console.log("🔥 Burn executed on Aptos:", aptosTxHash);

  /* -------------------- 4. WAIT FOR CCTP ATTESTATION ---------------------- */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.aptos,
      txHash: aptosTxHash,
    });

  console.log("🟢 CCTP attestation ready");

  /* -------------------- 5. CLAIM (HAPPY FLOW) ----------------------------- */
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote,
      targetAddress: await evmSigner.getAddress(),
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  const claimIx = claimRes.data.data.claimIx;
  console.log("✅ Claim instruction received");

  /* -------------------- 6. EXECUTE ON EVM (MINT) -------------------------- */
  const tx = await evmSigner.sendTransaction({
    to: claimIx.to,
    data: claimIx.data,
    value: BigNumber.from(claimIx.value),
    gasPrice: BigNumber.from(claimIx.gasPrice),
  });

  const receipt = await tx.wait();
  console.log("🎉 Minted on EVM:", receipt.transactionHash);
}

aptosToEvmSwap();

/* -------------------------------------------------------------------------- */
/*                              HELPERS                                       */
/* -------------------------------------------------------------------------- */

function normalizeAptosPayload(payload: any) {
  return {
    function: payload.function,
    typeArguments: payload.type_arguments ?? [],
    functionArguments: payload.arguments ?? [],
  };
}

async function executeAptosInstruction(
  aptos: Aptos,
  signer: Ed25519Account,
  instruction: {
    swapPayload?: any;
    bridgePayload?: any;
  }
): Promise<string> {
  let lastTxHash = "";

  // 1️⃣ SOURCE SWAP (APT → USDC)
  if (instruction.swapPayload) {
    const swapTx = await aptos.transaction.build.simple({
      sender: signer.accountAddress.toString(),
      data: normalizeAptosPayload(instruction.swapPayload),
    });

    const swapRes = await aptos.signAndSubmitTransaction({
      signer,
      transaction: swapTx,
    });

    await aptos.waitForTransaction({
      transactionHash: swapRes.hash,
      options: { checkSuccess: true },
    });

    console.log("🔁 Aptos swap executed:", swapRes.hash);
    lastTxHash = swapRes.hash;
  }

  // 2️⃣ BRIDGE BURN (USDC burn → CCTP)
  if (instruction.bridgePayload) {
    const bridgeTx = await aptos.transaction.build.simple({
      sender: signer.accountAddress.toString(),
      data: normalizeAptosPayload(instruction.bridgePayload),
    });

    const bridgeRes = await aptos.signAndSubmitTransaction({
      signer,
      transaction: bridgeTx,
    });

    await aptos.waitForTransaction({
      transactionHash: bridgeRes.hash,
      options: { checkSuccess: true },
    });

    console.log("🔥 Aptos burn executed:", bridgeRes.hash);
    lastTxHash = bridgeRes.hash;
  }

  return lastTxHash;
}

/* ------------------------- CCTP ATTESTATION POLLING ------------------------ */

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

  const pollIntervalMs = 3000;
  const maxRetries = 300;

  let retries = 0;

  while (retries < maxRetries) {
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

    retries++;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("CCTP attestation timeout");
}
