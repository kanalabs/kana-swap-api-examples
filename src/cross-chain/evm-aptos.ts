/**
 * Example: EVM → Aptos Cross-Chain Swap (FULL FLOW)
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
/*                                   CONFIG                                   */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // AVAX
const TARGET_TOKEN =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b"; // USDC (Aptos)

const AMOUNT_IN = "10000000000000000"; // 0.01 AVAX
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ------------------------------- EVM -------------------------------------- */

const evmProvider = new ethers.providers.JsonRpcProvider(
  process.env.AVALANCHE_RPC_URL!
);

const evmSigner = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  evmProvider
);

/* ------------------------------- APTOS ------------------------------------ */

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

/* -------------------------------------------------------------------------- */
/*                                MAIN FLOW                                   */
/* -------------------------------------------------------------------------- */

async function evmToAptosSwap() {
  /* ----------------------------- 1. QUOTE -------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.Avalanche,
      targetChain: NetworkId.aptos,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* -------------------- 2. BUILD SOURCE INSTRUCTIONS ---------------------- */
  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: await evmSigner.getAddress(),
      targetAddress: aptosAccount.accountAddress.toString(),
    },
    { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  /* -------------------- 3. EXECUTE BURN ON EVM ---------------------------- */
  const burnTxHash = await executeEvmInstruction(
    evmSigner,
    instruction
  );

  console.log("🔥 Burn executed on EVM:", burnTxHash);

  /* -------------------- 4. WAIT FOR CCTP ATTESTATION ---------------------- */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.Avalanche,
      txHash: burnTxHash,
    });

  console.log("🟢 CCTP attestation ready");

  /* -------------------- 5. CLAIM (HAPPY FLOW) ----------------------------- */
  const claimRes = await callClaimWithRetry({
    quote,
    targetAddress: aptosAccount.accountAddress.toString(),
    messageBytes,
    attestationSignature,
  });

  const claimPayload = claimRes.data.data.claimPayload;
  console.log("✅ Claim payload received");

  /* -------------------- 6. EXECUTE MINT ON APTOS -------------------------- */
  const mintTxHash = await executeAptosInstruction(
    aptos,
    aptosAccount,
    claimPayload
  );

  console.log("🎉 Minted on Aptos:", mintTxHash);
}

evmToAptosSwap();

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

/* ----------------------- EXECUTE EVM TX ----------------------------------- */
async function executeEvmInstruction(
  signer: ethers.Wallet,
  instruction: any
): Promise<string> {
  if (instruction.approveIX) {
    const tx = await signer.sendTransaction({
      to: instruction.approveIX.to,
      data: instruction.approveIX.data,
      value: BigNumber.from(instruction.approveIX.value),
      gasPrice: BigNumber.from(instruction.approveIX.gasPrice),
    });
    await tx.wait();
  }

  const tx = await signer.sendTransaction({
    to: instruction.transferIX.to,
    data: instruction.transferIX.data,
    value: BigNumber.from(instruction.transferIX.value),
    gasPrice: BigNumber.from(instruction.transferIX.gasPrice),
  });

  const receipt = await tx.wait();
  return receipt.transactionHash;
}

/* ----------------------- EXECUTE APTOS TX --------------------------------- */
function formatFunctionName(
  fn: string
): `${string}::${string}::${string}` {
  return fn as `${string}::${string}::${string}`;
}

async function executeAptosInstruction(
  aptos: Aptos,
  signer: Ed25519Account,
  payload: {
    function: string;
    type_arguments: string[];
    arguments: any[];
  }
): Promise<string> {
  const tx = await aptos.transaction.build.simple({
    sender: signer.accountAddress.toString(),
    data: {
      function: formatFunctionName(payload.function),
      typeArguments: payload.type_arguments,
      functionArguments: payload.arguments,
    },
    options: {
      gasUnitPrice: 100,
      maxGasAmount: 4000,
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

/* -------------------- RATE-LIMIT SAFE CLAIM CALL --------------------------- */
async function callClaimWithRetry(body: any) {
  while (true) {
    try {
      return await axios.post(
        `${KANA_API_URL}/v1/claim`,
        body,
        { headers }
      );
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfter = Number(
          err.response.headers["retry-after"] ?? 10
        );
        console.log(
          `⏳ Claim rate-limited. Retrying in ${retryAfter}s...`
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
}

/* -------------------- CCTP ATTESTATION POLLING ----------------------------- */

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

  const pollIntervalMs = 5000;
  const maxRetries = 400;

  for (let i = 0; i < maxRetries; i++) {
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

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("CCTP attestation timeout");
}
