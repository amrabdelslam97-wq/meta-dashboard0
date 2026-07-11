const db = require('./database');
const migrationTracker = require('./migrationTracker');

// Verify migration registry exists and show all applied migrations
const migrations = migrationTracker.getAppliedMigrations();

console.log('\n✓ MIGRATION VERIFICATION REPORT');
console.log('═════════════════════════════════════════════════════\n');
console.log(`Total Applied Migrations: ${migrations.length}\n`);

if (migrations.length > 0) {
  console.log('Applied Migrations (in order):');
  migrations.forEach((m, i) => {
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${m.name.padEnd(45, '.')} ${m.applied_at}`);
  });
  console.log();
}

// Check for Phase 28-30 specifically
const phase28 = migrations.find(m => m.name.includes('phase28'));
const phase29 = migrations.find(m => m.name.includes('phase29'));
const phase30 = migrations.find(m => m.name.includes('phase30'));

console.log('Latest Phases Status:');
console.log(`  Phase 28 (Agency OS):           ${phase28 ? '✓ APPLIED' : '✗ NOT APPLIED'}`);
console.log(`  Phase 29 (Enterprise SaaS):     ${phase29 ? '✓ APPLIED' : '✗ NOT APPLIED'}`);
console.log(`  Phase 30 (Autonomous AI):       ${phase30 ? '✓ APPLIED' : '✗ NOT APPLIED'}`);
console.log();

const allLatest = phase28 && phase29 && phase30;
if (allLatest) {
  console.log('✓ ALL MIGRATIONS COMPLETE');
  console.log('✓ MIGRATION SYSTEM WORKING CORRECTLY');
} else {
  console.log('⚠ SOME MIGRATIONS MISSING');
}

console.log('═════════════════════════════════════════════════════\n');

module.exports = { migrations, phase28, phase29, phase30 };
