/** 使用新版持仓级同步；凭据只从环境变量读取。 */
const trading212 = require('../src/services/trading212Service.cjs');

if (!trading212.configured()) {
  console.error('缺少 T212_API_KEY 或 T212_API_SECRET 环境变量');
  process.exit(1);
}

trading212.sync()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(`Trading212 同步失败: ${error.message}`);
    process.exit(1);
  });
