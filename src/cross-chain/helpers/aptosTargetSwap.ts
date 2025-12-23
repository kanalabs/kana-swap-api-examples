import axios from "axios";
import { Aptos, Ed25519Account } from "@aptos-labs/ts-sdk";
import { KANA_API_URL } from "../../constant";

/* ------------------ INTERNAL ------------------ */

function formatFunctionName(
  fn: string
): `${string}::${string}::${string}` {
  return fn as `${string}::${string}::${string}`;
}

/* ------------------ APTOS TARGET SWAP ------------------ */

export async function executeAptosTargetSwap(params: {
  aptos: Aptos;
  signer: Ed25519Account;
  route: {
    sourceToken: string;
    targetToken: string;
    amountIn: string;
    chainId: number;
  };
}) {
  /* 1. Get swap quote */
  const quoteRes = await axios.get(`${KANA_API_URL}/v1/swapQuote`, {
    params: {
      inputToken: params.route.sourceToken,
      outputToken: params.route.targetToken,
      chain: params.route.chainId,
      amountIn: params.route.amountIn,
    },
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.XYRA_API_KEY!,
    },
  });

  const swapQuote = quoteRes.data.data[0];

  /* 2. Get swap instruction */
  const ixRes = await axios.post(
    `${KANA_API_URL}/v1/swapInstruction`,
    {
      quote: swapQuote,
      address: params.signer.accountAddress.toString(),
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": process.env.XYRA_API_KEY!,
      },
    }
  );

  const payload = ixRes.data.data.swapPayload;

  /* 3. Execute on Aptos */
  const tx = await params.aptos.transaction.build.simple({
    sender: params.signer.accountAddress.toString(),
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

  const res = await params.aptos.signAndSubmitTransaction({
    signer: params.signer,
    transaction: tx,
  });

  await params.aptos.waitForTransaction({
    transactionHash: res.hash,
    options: { checkSuccess: true },
  });

  return res.hash;
}
