
import { prisma } from "./src/config/db";
import { decrypt } from "./src/services/encryption";

async function main() {
  const senders = await prisma.sender.findMany({
    select: {
      id: true,
      email: true,
      smtpPassword: true
    }
  });

  for (const sender of senders) {
    const decrypted = decrypt(sender.smtpPassword);

    console.log({
      sender: sender.email,
      encrypted: sender.smtpPassword.includes(":"),
      decryptionSuccessful: decrypted.length > 0
    });
  }
}

main()
  .catch((error) => {
    console.error("Verification failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
