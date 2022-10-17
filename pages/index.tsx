import React, { useEffect, useState } from "react";
import { serverSideTranslations } from "next-i18next/serverSideTranslations";
import { useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@project-serum/anchor";
import useMangoStore from "stores/useMangoStore";
import useReimbursementStore from "stores/useReimbursementStore";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import Button from "components/Button";
import { chunks, isExistingTokenAccount } from "utils/tools";
import { TOKEN_PROGRAM_ID } from "@project-serum/serum/lib/token-instructions";
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { sendSignAndConfirmTransactions } from "@blockworks-foundation/mangolana/lib/transactions";
import { SequenceType } from "@blockworks-foundation/mangolana/lib/globalTypes";

const GROUP_NUM = 5;

export async function getStaticProps({ locale }) {
  return {
    props: {
      ...(await serverSideTranslations(locale, [
        "common",
        "delegate",
        "tv-chart",
        "alerts",
        "share-modal",
        "profile",
      ])),
      // Will be passed to the page component as props
    },
  };
}

const MainPage = () => {
  const connection = useMangoStore((s) => s.connection);
  const wallet = useWallet();
  const { reimbursementClient } = useReimbursementStore();
  const [mintInfos, setMintInfos] = useState([]);
  const [table, setTable] = useState([]);
  const getAmounts = async (walletPk: PublicKey) => {
    const result = await reimbursementClient.program.account.group.all();
    const group = result.find((group) => group.account.groupNum === GROUP_NUM);
    const table = await reimbursementClient.decodeTable(group);
    const balancesForUser = table.rows.find((row) =>
      row.owner.equals(walletPk)
    ).balances;

    console.log(balancesForUser);
  };
  const handleReimbursementAccount = async (
    group: any,
    reimbursementAccount: PublicKey
  ) => {
    const instructions: TransactionInstruction[] = [];
    const isExistingReimbursementAccount =
      await connection.current.getAccountInfo(reimbursementAccount);
    if (!isExistingReimbursementAccount) {
      const instruction = await reimbursementClient.program.methods
        .createReimbursementAccount()
        .accounts({
          group: (group as any).publicKey,
          mangoAccountOwner: wallet.publicKey,
          payer: wallet.publicKey,
        })
        .instruction();
      instructions.push(instruction);
    }
    return instructions;
  };
  const reimburse = async (group: any, reimbursementAccount: PublicKey) => {
    const instructions: TransactionInstruction[] = [];
    const mintPk = group?.account.mints[0];
    const ataPk = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
      TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
      mintPk, // mint
      wallet.publicKey!, // owner
      true
    );
    const isExistingAta = await isExistingTokenAccount(
      connection.current,
      ataPk
    );
    if (!isExistingAta) {
      instructions.push(
        Token.createAssociatedTokenAccountInstruction(
          ASSOCIATED_TOKEN_PROGRAM_ID, // always ASSOCIATED_TOKEN_PROGRAM_ID
          TOKEN_PROGRAM_ID, // always TOKEN_PROGRAM_ID
          mintPk, // mint
          ataPk, // ata
          wallet.publicKey!, // owner of token account
          wallet.publicKey! // fee payer
        )
      );
    }
    instructions.push(
      await reimbursementClient.program.methods
        .reimburse(new BN(0), new BN(0), false)
        .accounts({
          group: (group as any).publicKey,
          vault: group?.account.vaults[0],
          tokenAccount: ataPk,
          mint: mintPk,
          reimbursementAccount,
          mangoAccountOwner: wallet.publicKey,
          table: group?.account.table,
        })
        .instruction()
    );
    return instructions;
  };
  const handleReimbursement = async () => {
    const result = await reimbursementClient.program.account.group.all();
    const group = result.find((group) => group.account.groupNum === GROUP_NUM);
    const reimbursementAccount = (
      await PublicKey.findProgramAddress(
        [
          Buffer.from("ReimbursementAccount"),
          group!.publicKey.toBuffer()!,
          wallet!.publicKey!.toBuffer(),
        ],
        reimbursementClient.program.programId
      )
    )[0];
    const accountInstructions = await handleReimbursementAccount(
      group,
      reimbursementAccount
    );
    const reimburseInstructions = await reimburse(group, reimbursementAccount);
    const reimburseInstructionsChunks = chunks([...reimburseInstructions], 4);
    const instructionsToSend = [
      ...accountInstructions.map((x) => {
        return {
          instructionsSet: [x].map((j) => {
            return { transactionInstruction: j, signers: [] };
          }),
          sequenceType: SequenceType.Sequential,
        };
      }),
      ...reimburseInstructionsChunks.map((x) => {
        return {
          instructionsSet: x.map((j) => {
            return { transactionInstruction: j, signers: [] };
          }),
          sequenceType: SequenceType.Parallel,
        };
      }),
    ];

    await sendSignAndConfirmTransactions({
      connection: connection.current,
      wallet,
      transactionInstructions: instructionsToSend,
    });
  };
  useEffect(() => {
    if (reimbursementClient) {
      getAmounts(wallet.publicKey!);
    }
  }, [reimbursementClient !== null]);

  return (
    <div className="min-h-[400px] p-4">
      {wallet.connected ? (
        <>
          <div className="pb-4">
            Connected wallet: {wallet.publicKey?.toBase58()}
          </div>
          <div>
            <Button onClick={handleReimbursement}>Reimburse</Button>
          </div>
        </>
      ) : (
        <div>Please connect your wallet</div>
      )}
    </div>
  );
};

export default MainPage;
