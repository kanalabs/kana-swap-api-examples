import { Aptos, Ed25519Account } from "@aptos-labs/ts-sdk";

/* ------------------ INTERNAL ------------------ */

function formatFunctionName(
  fn: string
): `${string}::${string}::${string}` {
  return fn as `${string}::${string}::${string}`;
}

/* ------------------ EXECUTE APTOS BURN ------------------ */

export async function executeAptosBurn(
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
