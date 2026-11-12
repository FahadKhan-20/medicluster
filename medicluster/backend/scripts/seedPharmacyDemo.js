/**
 * backend/scripts/seedPharmacyDemo.js
 * Seed 2 demo pharmacies with stock, 1 pharmacist per pharmacy, and 2 couriers.
 * Passwords are read strictly from PHARMA_DEMO_PASSWORD env var.
 *
 * Usage:
 *   PHARMA_DEMO_PASSWORD="your-secure-password" node scripts/seedPharmacyDemo.js
 *
 * NOT run automatically.
 */

const bcrypt = require("bcryptjs");
const Pharmacy = require("../models/Pharmacy");
const PharmacyStaff = require("../models/PharmacyStaff");
const PharmacyStock = require("../models/PharmacyStock");

const ESSENTIAL_DRUGS = [
  { drug: "Amoxicillin", strength: "500mg", form: "capsule", quantity: 150, reorderThreshold: 30, barcode: "890100000001" },
  { drug: "Paracetamol", strength: "650mg", form: "tablet", quantity: 300, reorderThreshold: 50, barcode: "890100000002" },
  { drug: "Lisinopril", strength: "10mg", form: "tablet", quantity: 120, reorderThreshold: 20, barcode: "890100000003" },
  { drug: "Metformin", strength: "500mg", form: "tablet", quantity: 200, reorderThreshold: 40, barcode: "890100000004" },
  { drug: "Cetirizine", strength: "10mg", form: "tablet", quantity: 100, reorderThreshold: 20, barcode: "890100000005" },
  { drug: "Salbutamol", strength: "100mcg", form: "inhaler", quantity: 50, reorderThreshold: 10, barcode: "890100000006" },
  { drug: "Azithromycin", strength: "250mg", form: "tablet", quantity: 80, reorderThreshold: 15, barcode: "890100000007" },
  { drug: "Omeprazole", strength: "20mg", form: "capsule", quantity: 140, reorderThreshold: 25, barcode: "890100000008" },
  { drug: "Atorvastatin", strength: "20mg", form: "tablet", quantity: 160, reorderThreshold: 30, barcode: "890100000009" },
  { drug: "Ibuprofen", strength: "400mg", form: "tablet", quantity: 220, reorderThreshold: 40, barcode: "890100000010" },
];

async function seedPharmacyDemo() {
  const password = process.env.PHARMA_DEMO_PASSWORD;
  if (!password || !password.trim()) {
    console.error("Error: PHARMA_DEMO_PASSWORD environment variable is required and cannot be empty.");
    if (require.main === module) process.exit(1);
    throw new Error("PHARMA_DEMO_PASSWORD environment variable is required");
  }

  const passwordHash = await bcrypt.hash(password.trim(), 10);

  // 1. Pharmacy 1: Central
  let pharmCentral = await Pharmacy.findOne({ name: "MediCluster Central Pharmacy" }).lean();
  if (!pharmCentral) {
    pharmCentral = await Pharmacy.create({
      name: "MediCluster Central Pharmacy",
      address: "100 Medical City Way, Central District, Bengaluru",
      lat: 12.9716,
      lng: 77.5946,
      phone: "+918022001001",
      active: true,
    });
    console.log("Created Pharmacy: MediCluster Central Pharmacy (" + pharmCentral._id + ")");
  } else {
    console.log("Found existing Pharmacy: MediCluster Central Pharmacy (" + pharmCentral._id + ")");
  }

  // 2. Pharmacy 2: Southside
  let pharmSouth = await Pharmacy.findOne({ name: "MediCluster Southside Pharmacy" }).lean();
  if (!pharmSouth) {
    pharmSouth = await Pharmacy.create({
      name: "MediCluster Southside Pharmacy",
      address: "250 Southern Cross Rd, Jayanagar, Bengaluru",
      lat: 12.9250,
      lng: 77.5890,
      phone: "+918022001002",
      active: true,
    });
    console.log("Created Pharmacy: MediCluster Southside Pharmacy (" + pharmSouth._id + ")");
  } else {
    console.log("Found existing Pharmacy: MediCluster Southside Pharmacy (" + pharmSouth._id + ")");
  }

  // 3. Seed Stock for both pharmacies
  for (const item of ESSENTIAL_DRUGS) {
    for (const pharm of [pharmCentral, pharmSouth]) {
      const existing = await PharmacyStock.findOne({
        pharmacyId: String(pharm._id),
        drug: item.drug,
      }).lean();
      if (!existing) {
        await PharmacyStock.create({
          pharmacyId: String(pharm._id),
          drug: item.drug,
          strength: item.strength,
          form: item.form,
          quantity: item.quantity,
          reorderThreshold: item.reorderThreshold,
          barcode: `${item.barcode}-${pharm._id.toString().slice(-4)}`,
        });
      }
    }
  }
  console.log("Stock seeded for both demo pharmacies.");

  // 4. Seed Pharmacist 1 for Central Pharmacy
  const p1Email = "pharmacist.central@medicluster.demo";
  let pharmacist1 = await PharmacyStaff.findOne({ email: p1Email }).lean();
  if (!pharmacist1) {
    pharmacist1 = await PharmacyStaff.create({
      name: "Dr. Arvind Rao",
      role: "pharmacist",
      email: p1Email,
      passwordHash,
      pharmacyIds: [String(pharmCentral._id)],
      active: true,
    });
    console.log("Created Pharmacist 1: " + p1Email);
  } else {
    console.log("Found existing Pharmacist 1: " + p1Email);
  }

  // 5. Seed Pharmacist 2 for Southside Pharmacy
  const p2Email = "pharmacist.south@medicluster.demo";
  let pharmacist2 = await PharmacyStaff.findOne({ email: p2Email }).lean();
  if (!pharmacist2) {
    pharmacist2 = await PharmacyStaff.create({
      name: "Dr. Sunita Patel",
      role: "pharmacist",
      email: p2Email,
      passwordHash,
      pharmacyIds: [String(pharmSouth._id)],
      active: true,
    });
    console.log("Created Pharmacist 2: " + p2Email);
  } else {
    console.log("Found existing Pharmacist 2: " + p2Email);
  }

  // 6. Seed Courier 1
  const c1Phone = "+919999911101";
  let courier1 = await PharmacyStaff.findOne({ phone: c1Phone }).lean();
  if (!courier1) {
    courier1 = await PharmacyStaff.create({
      name: "Ramesh Courier",
      role: "courier",
      phone: c1Phone,
      passwordHash,
      pharmacyIds: [String(pharmCentral._id), String(pharmSouth._id)],
      active: true,
    });
    console.log("Created Courier 1: " + c1Phone);
  } else {
    console.log("Found existing Courier 1: " + c1Phone);
  }

  // 7. Seed Courier 2
  const c2Phone = "+919999911102";
  let courier2 = await PharmacyStaff.findOne({ phone: c2Phone }).lean();
  if (!courier2) {
    courier2 = await PharmacyStaff.create({
      name: "Kavita Express",
      role: "courier",
      phone: c2Phone,
      passwordHash,
      pharmacyIds: [String(pharmCentral._id), String(pharmSouth._id)],
      active: true,
    });
    console.log("Created Courier 2: " + c2Phone);
  } else {
    console.log("Found existing Courier 2: " + c2Phone);
  }

  // Print summary of logins
  console.log("\n=======================================================");
  console.log(" DEMO PHARMACY LOGINS (Password: from PHARMA_DEMO_PASSWORD)");
  console.log("=======================================================");
  console.log(" Pharmacist 1 (Central):");
  console.log("   Email:    " + p1Email);
  console.log("   Pharmacy: MediCluster Central Pharmacy (" + pharmCentral._id + ")");
  console.log(" Pharmacist 2 (Southside):");
  console.log("   Email:    " + p2Email);
  console.log("   Pharmacy: MediCluster Southside Pharmacy (" + pharmSouth._id + ")");
  console.log(" Courier 1:");
  console.log("   Phone:    " + c1Phone);
  console.log("   Role:     courier");
  console.log(" Courier 2:");
  console.log("   Phone:    " + c2Phone);
  console.log("   Role:     courier");
  console.log("=======================================================\n");

  return {
    pharmacies: [pharmCentral, pharmSouth],
    staff: [pharmacist1, pharmacist2, courier1, courier2],
  };
}

if (require.main === module) {
  seedPharmacyDemo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { seedPharmacyDemo };
