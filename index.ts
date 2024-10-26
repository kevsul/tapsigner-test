import { doBitcoin } from './bitcoin/bitcoin';
import { doHedera } from './hedera/hedera';
import { CKTapCard } from './protocol';
import { doXrpl } from './xrpl/xrpl';


(async () => {

  await doBitcoin();
  // await doXrpl();
  // await doHedera();

})();
