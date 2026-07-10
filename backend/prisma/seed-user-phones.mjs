// Idempotent phone seed — gives the demo users phone numbers so WhatsApp-OTP
// login (POST /auth/otp/request|verify) is testable. Only fills phones that are
// currently NULL: never overwrites a real phone, safe to run on every deploy.
//
// OTP matching is on the LAST 10 DIGITS, so store the bare 10-digit form.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PHONES = [
  { email: 'head.office@caratsense.in', phone: '9100000001' },
  { email: 'neelam.area@caratsense.in', phone: '9100000002' },
  { email: 'aarav.mehta@caratsense.in', phone: '9100000003' },
  { email: 'priya.rep@caratsense.in', phone: '9100000004' },
  { email: 'karan.malhotra@caratsense.in', phone: '9100000005' },
  { email: 'rina.rep@caratsense.in', phone: '9100000006' },
];

async function main() {
  console.log('Seeding demo-user phones…');
  for (const { email, phone } of PHONES) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.log(`  skip (no user): ${email}`);
      continue;
    }
    if (user.phone) {
      console.log(`  keep ${email} → ${user.phone} (already set)`);
      continue;
    }
    await prisma.user.update({ where: { id: user.id }, data: { phone } });
    console.log(`  set  ${email} → ${phone}`);
  }
  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
