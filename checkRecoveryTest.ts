
import { prisma } from "./src/config/db";

async function main() {
  const email = await prisma.email.findUnique({
    where: {
      id: "cmwulnsw400042nxc5zlfvmwk"
    },
    select: {
      id: true,
      recipient: true,
      subject: true,
      status: true,
      campaignId: true,
      updatedAt: true
    }
  });

  console.log("Recovery test email:");
  console.log(email);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
