/**
 * backend/scripts/seedPharmacy.js
 * Seed one test pharmacy, one pharmacist, and one courier.
 * Usage: ALLOW_SEED=1 node scripts/seedPharmacy.js
 */

const bcrypt = require("bcryptjs");
const Pharmacy = require("../models/Pharmacy");
const PharmacyStaff = require("../models/PharmacyStaff");

async function seed() {
  if (process.env.ALLOW_SEED !== "1") {
    console.error("Refusing to seed: ALLOW_SEED=1 environment variable is required.");
    process.exit(1);
  }

  let pharmacy = await Pharmacy.findOne({ name: "MediCluster Test Pharmacy" }).lean();
  if (!pharmacy) {
    pharmacy = await Pharmacy.create({
      name: "MediCluster Test Pharmacy",
      address: "123 Central Blvd, Bengaluru",
      lat: 12.9716,
      lng: 77.5946,
      phone: "+918000000000",
      active: true,
    });
    console.log("Created pharmacy:", pharmacy._id);
  } else {
    console.log("Pharmacy already exists:", pharmacy._id);
  }

  const pharmacistEmail = "pharmacist@test.local";
  let pharmacist = await PharmacyStaff.findOne({ email: pharmacistEmail }).lean();
  if (!pharmacist) {
    const passwordHash = await bcrypt.hash("pharm-test-1234", 10);
    pharmacist = await PharmacyStaff.create({
      name: "Test Pharmacist",
      role: "pharmacist",
      email: pharmacistEmail,
      passwordHash,
      pharmacyIds: [String(pharmacy._id)],
      active: true,
    });
    console.log("Created pharmacist:", pharmacistEmail);
  } else {
    console.log("Pharmacist already exists:", pharmacistEmail);
  }

  const courierPhone = "+910000000001";
  let courier = await PharmacyStaff.findOne({ phone: courierPhone }).lean();
  if (!courier) {
    const pinHash = await bcrypt.hash("4321", 10);
    courier = await PharmacyStaff.create({
      name: "Test Courier",
      role: "courier",
      phone: courierPhone,
      passwordHash: pinHash,
      pharmacyIds: [String(pharmacy._id)],
      active: true,
    });
    console.log("Created courier:", courierPhone);
  } else {
    console.log("Courier already exists:", courierPhone);
  }
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed error:", err);
      process.exit(1);
    });
}

module.exports = { seed };
