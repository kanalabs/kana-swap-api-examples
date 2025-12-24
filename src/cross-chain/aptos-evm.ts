/**
 * Aptos → Polygon cross-chain swap
 * Burn → Attestation → Claim → Mint USDC → Swap to POL (MATIC)
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

import { ethers, BigNumber } from "ethers";
import { KANA_API_URL, NetworkId } from "../constant";

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                      */
/* -------------------------------------------------------------------------- */

const SOURCE_TOKEN = "0x1::aptos_coin::AptosCoin";
const TARGET_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // POL / MATIC
const AMOUNT_IN = "1000000";
const SLIPPAGE = 0.5;

const headers = {
  "Content-Type": "application/json",
  "X-API-KEY": process.env.XYRA_API_KEY!,
};

/* ----------------------------- APTOS SETUP -------------------------------- */

const aptos = new Aptos(new AptosConfig({ network: Network.MAINNET }));

const aptosAccount = new Ed25519Account({
  privateKey: new Ed25519PrivateKey(
    PrivateKey.formatPrivateKey(
      process.env.APTOS_PRIVATE_KEY!,
      PrivateKeyVariants.Ed25519
    )
  ),
});

/* ------------------------------ POLYGON SETUP ----------------------------- */

const provider = new ethers.providers.JsonRpcProvider(
  process.env.POLYGON_RPC_URL!
);

(provider as any)._isEip1559 = false;

const signer = new ethers.Wallet(
  process.env.EVM_PRIVATE_KEY!,
  provider
);

/* ------------------------- EVM EXECUTOR (REUSED) -------------------------- */

interface TransactionIX {
  to: string;
  from: string;
  value: string;
  data: string;
  gasPrice: string;
  chainId: number;
}

interface SwapIX {
  approveIX?: TransactionIX;
  swapIX: TransactionIX;
}

function increaseGasLimit(gas: number) {
  return Math.ceil(gas * 1.1);
}

async function executeEVMInstruction(
  signer: ethers.Wallet,
  instruction: SwapIX
) {
  const provider = signer.provider!;
  const gasPrice = await provider.getGasPrice(); // legacy gas

  if (instruction.approveIX) {
    const a = instruction.approveIX;

    const approveTx = {
      from: a.from,
      to: a.to,
      data: a.data,
      value: BigNumber.from(a.value),
      gasPrice,
      chainId: a.chainId,
    };

    const gas = await provider.estimateGas(approveTx);
    const tx = await signer.sendTransaction({
      ...approveTx,
      gasLimit: gas.mul(110).div(100), // +10%
    });

    await tx.wait();
  }

  const s = instruction.swapIX;

  const swapTx = {
    from: s.from,
    to: s.to,
    data: s.data,
    value: BigNumber.from(s.value),
    gasPrice,
    chainId: s.chainId,
  };

  const gas = await provider.estimateGas(swapTx);
  const tx = await signer.sendTransaction({
    ...swapTx,
    gasLimit: gas.mul(110).div(100),
  });

  const receipt = await tx.wait();
  return receipt.transactionHash;
}


/* -------------------------------------------------------------------------- */
/* MAIN FLOW                                                                   */
/* -------------------------------------------------------------------------- */

async function aptosToPolygonSwap() {
  console.log("🚀 Aptos → Polygon swap started");

  /* --------------------------- 1. QUOTE ---------------------------------- */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/crossChainQuote`, {
    params: {
      sourceToken: SOURCE_TOKEN,
      targetToken: TARGET_TOKEN,
      sourceChain: NetworkId.aptos,
      targetChain: NetworkId.polygon,
      amountIn: AMOUNT_IN,
      sourceSlippage: SLIPPAGE,
      targetSlippage: SLIPPAGE,
    },
    headers,
  });

  const quote = quoteRes.data.data[0];
  console.log("✅ Quote fetched");

  /* ---------------------- 2. SOURCE INSTRUCTIONS -------------------------- */
  const transferRes = await axios.post(
    `${KANA_API_URL}/v1/crossChainTransfer`,
    {
      quote,
      sourceAddress: aptosAccount.accountAddress.toString(),
      targetAddress: signer.address,
    },
    { headers }
  );

  const instruction = transferRes.data.data;
  console.log("✅ Source instructions built");

  /* -------------------- 3. EXECUTE ON APTOS ------------------------------- */
  const aptosTxHash = await executeAptosInstruction(
    aptos,
    aptosAccount,
    instruction
  );
  console.log("🔥 Burn executed:", aptosTxHash);

  /* -------------------- 4. ATTESTATION ----------------------------------- */
  const { messageBytes, attestationSignature } =
    await waitForAttestation({
      sourceChain: NetworkId.aptos,
      txHash: aptosTxHash,
    });

  console.log("🟢 Attestation ready");

  /* -------------------- 5. CLAIM → MINT USDC ------------------------------ */
  const claimRes = await axios.post(
    `${KANA_API_URL}/v1/claim`,
    {
      quote,
      targetAddress: signer.address,
      messageBytes,
      attestationSignature,
    },
    { headers }
  );

  const claimIx = claimRes.data.data.claimIx;

  const mintTx = await signer.sendTransaction({
    from: claimIx.from,
    to: claimIx.to,
    data: claimIx.data,
    chainId: claimIx.chainId,
    gasPrice: BigNumber.from(claimIx.gasPrice).toHexString(),
    value: BigNumber.from(claimIx.value).toHexString()
  });

  console.log("⏳ Minting USDC on Polygon...");
  await mintTx.wait();
  console.log("🎉 Mint confirmed");

  /* -------------------- 6. TARGET SWAP (KEY FIX) -------------------------- */

  if (!quote.targetSwapRoute) {
    console.log("🏁 No target swap required");
    return;
  }

  const swapQuoteRes = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: quote.targetSwapRoute.sourceToken,
      outputToken: quote.targetSwapRoute.targetToken,
      chain: NetworkId.polygon,
      amountIn: quote.targetSwapRoute.amountIn,
      slippage: SLIPPAGE,
    },
    headers,
  });

  const swapInstructionRes = await axios.post(
    `${KANA_API_URL}/v1/swapInstruction`,
    {
      quote: swapQuoteRes.data.data[0],
      address: signer.address,
    },
    { headers }
  );

  console.log("⏳ Swapping USDC → POL...");
  const hash = await executeEVMInstruction(
    signer,
    swapInstructionRes.data.data
  );

  console.log("🚀 Final swap complete:", hash);
}

aptosToPolygonSwap();

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
  instruction: any
): Promise<string> {
  let lastTx = "";

  if (instruction.swapPayload) {
    const tx = await aptos.transaction.build.simple({
      sender: signer.accountAddress.toString(),
      data: normalizeAptosPayload(instruction.swapPayload),
    });

    const res = await aptos.signAndSubmitTransaction({
      signer,
      transaction: tx,
    });

    await aptos.waitForTransaction({
      transactionHash: res.hash,
      options: { checkSuccess: true },
    });

    lastTx = res.hash;
  }

  if (instruction.bridgePayload) {
    const tx = await aptos.transaction.build.simple({
      sender: signer.accountAddress.toString(),
      data: normalizeAptosPayload(instruction.bridgePayload),
    });

    const res = await aptos.signAndSubmitTransaction({
      signer,
      transaction: tx,
    });

    await aptos.waitForTransaction({
      transactionHash: res.hash,
      options: { checkSuccess: true },
    });

    lastTx = res.hash;
  }

  return lastTx;
}

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

    await new Promise((r) => setTimeout(r, 3000));
  }
}
