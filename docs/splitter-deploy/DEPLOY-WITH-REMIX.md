# Deploy the ShibPayments burn splitter with Remix

You only need this if you want burns on Ethereum to happen **inside the payment**. Without it, nothing breaks: Ethereum payments work like every other network, where the shop is paid in full and burns its share later with the burn helper.

## What gets deployed

- **Contract:** `ShibPaySplitter`, about 75 lines. It has no owner and no fee, holds nothing, and can't be upgraded. It splits one payment between the shop and `0x…dEaD`. The source is `ShibPaySplitter.sol` in this folder.
- **Network:** Ethereum mainnet only.
- **Address:** it will land at **`0xd25D81E6BF55465BAbe85eA543EB6e8bCbFaba82`**, the address the website already looks for. When code appears there, the checkout switches to burning in the payment by itself. The site doesn't need changing or redeploying.
- **Cost:** about **460,000 gas**, measured in a local test. At 2 gwei that's about 0.001 ETH.
- **Your wallet:** it only pays the gas. It gets no rights over the contract.

To land at that exact address, you don't compile the contract in Remix. You send the exact bytes the site was built with to the standard "CREATE2 deployer". That deployer lives at `0x4e59b44847b379578588920cA78FbF26c0B4956C` on Ethereum and is used by Foundry, Safe and others. Compiling in Remix would give slightly different bytes and a different address, and the site would never find it.

## Steps (about 5 minutes)

1. Open **https://remix.ethereum.org**.
2. Create a new file named `Create2Deployer.sol` and paste this into it. It only teaches Remix how to send raw data to the deployer:

   ```solidity
   // SPDX-License-Identifier: MIT
   pragma solidity ^0.8.0;
   contract Create2Deployer { fallback() external payable {} }
   ```

3. Open the **Solidity compiler** tab and click **Compile Create2Deployer.sol**. Any 0.8 version works.
4. Open the **Deploy & run transactions** tab:
   - Set **Environment** to **Injected Provider - MetaMask**. Approve the connection, and make sure MetaMask is on **Ethereum Mainnet**.
   - Set **Contract** to `Create2Deployer`.
   - **Don't click Deploy.** Paste `0x4e59b44847b379578588920cA78FbF26c0B4956C` into the **At Address** box, then click **At Address**.
5. Under **Deployed Contracts**, expand the new entry and scroll to **Low level interactions**.
6. Paste the whole contents of `deploy-calldata.txt` into **CALLDATA**. It's one long line that starts with `0x5368696250…`. Leave **Value** at 0.
7. Click **Transact** and confirm in MetaMask. The gas should show about 460k. If MetaMask warns that the transaction will fail, stop and send me a screenshot.
8. Once it confirms, open https://etherscan.io/address/0xd25D81E6BF55465BAbe85eA543EB6e8bCbFaba82. It should now show as a contract.

## Verify the source on Etherscan (recommended)

This lets anyone read the code on Etherscan.

1. On that Etherscan page, open **Contract → Verify and Publish**.
2. Fill in the form:
   - **Compiler type:** Solidity (Standard-Json-Input)
   - **Compiler version:** v0.8.24+commit.e11b9ed9
   - **License:** MIT
3. Upload `standard-json-input.json` from this folder.
4. Leave **constructor arguments** empty, because there are none.

## Without Remix

You can send the same transaction straight from MetaMask:
1. In MetaMask, open **Settings → Advanced** and turn on **Show hex data**.
2. Send **0 ETH** to `0x4e59b44847b379578588920cA78FbF26c0B4956C` on Ethereum, with the contents of `deploy-calldata.txt` in the **Hex data** box.

The developer route is `PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts` from the repo. It does the same thing and skips the deploy if the contract is already there.

## Files in this folder

| File | What it is |
| --- | --- |
| `ShibPaySplitter.sol` | The contract source, for reading. |
| `deploy-calldata.txt` | The salt plus the compiled contract, exactly as the site expects it. I checked it produces `0xd25D…ba82`. |
| `standard-json-input.json` | Etherscan verification input: solc 0.8.24, optimizer on with 10,000 runs, EVM version paris. |

The contract hasn't had an external audit.
