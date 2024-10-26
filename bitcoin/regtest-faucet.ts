import Client from 'bitcoin-core';
import retry from 'async-retry';

const connectionOptions = {
  host: '127.0.0.1',
  password: 'foobar',
  port: '18332',
  timeout: 30000,
  username: 'bitcoinrpc'
};

const waitForBlock = (client: Client, block: number, retries = 10) =>
  retry(
    async () => {
      const { blocks } = await client.getBlockchainInfo();

      if (blocks < block) {
        throw new Error();
      }
    },
    {
      factor: 1,
      minTimeout: 1000,
      retries
    }
  );

export async function mine(client: Client, blocksNum: number): Client {
  const { blocks } = await client.getBlockchainInfo();
  const coinbaseAddr = await client.getNewAddress();

  await client.generateToAddress(blocksNum, coinbaseAddr);
  await waitForBlock(client, blocks + blocksNum);
}

export const faucet = new Client({
  wallet: '',
  ...connectionOptions
});

async function checkFaucetBalance() {
  const wallets = await faucet.listWallets();

  if (!wallets.length) {
    await faucet.createWallet('');
  }

  let balance = await faucet.getBalance();

  if (!balance) {
    await mine(faucet, 150);
    balance = await faucet.getBalance();
  }
}

export async function fundAddress(address: string, amountBtc: string, confirmations = 0) {
  await checkFaucetBalance();

  await faucet.sendToAddress(address, Number(amountBtc));
  if (confirmations > 0) {
    await mine(faucet, confirmations);
  }
}
