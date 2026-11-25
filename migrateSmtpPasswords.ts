
import { prisma } from "./src/config/db";
import { encrypt } from "./src/services/encryption";

async function main() {
  const senders = await prisma.sender.findMany({
    select: {
      id: true,
      email: true,
      smtpPassword: true
    }
  });

  let migrated = 0;
  let alreadyEncrypted = 0;

  for (const sender of senders) {
    // Skip passwords that already use our encrypted format.
    const parts = sender.smtpPassword.split(":");

    const looksEncrypted =
      parts.length === 3 &&
      /^[0-9a-fA-F]{24}$/.test(parts[0]) &&
      /^[0-9a-fA-F]{32}$/.test(parts[1]) &&
      /^[0-9a-fA-F]+$/.test(parts[2]);

    if (looksEncrypted) {
      alreadyEncrypted++;
      continue;
    }

    const encryptedPassword = encrypt(sender.smtpPassword);

    await prisma.sender.update({
      where: { id: sender.id },
      data: {
        smtpPassword: encryptedPassword
      }
    });

    migrated++;

    console.log(`Encrypted SMTP password for: ${sender.email}`);
  }

  console.log("\nMigration completed.");
  console.log(`Migrated: ${migrated}`);
  console.log(`Already encrypted: ${alreadyEncrypted}`);
}

main()
  .catch((error) => {
    console.error("SMTP password migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
