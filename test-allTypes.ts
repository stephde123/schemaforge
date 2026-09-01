import { SchemaBrain } from './src/core/schema-brain';

async function main() {
  try {
    const b = await SchemaBrain.load('./data/schemaorg-current-https.jsonld');
    const all = b.allTypes();
    console.log('total types:', all.length);
    const uppercase = all.filter(t => /^[A-Z]/.test(t));
    console.log('uppercase only:', uppercase.length);
    console.log('sample 30:', uppercase.slice(0,30).join(', '));
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
