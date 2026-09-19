const { chromium } = require('playwright');
const path = require('path');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('BROWSER ERROR:', err.message));

  console.log('1. Navigating to login...');
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });

  console.log('2. Logging in as head.office@caratsense.in...');
  await page.fill('input[type="email"], #email', 'head.office@caratsense.in');
  await page.fill('input[type="password"], #password', 'password123');
  await page.click('button[type="submit"]');

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  console.log('Logged in successfully. Current URL:', page.url());

  console.log('3. Navigating to /catalogue...');
  await page.goto('http://localhost:3000/catalogue', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=AI image search', { timeout: 15000 });
  await page.waitForTimeout(3000);

  // Take screenshot of catalogue default view
  const artifactDir = 'C:\\Users\\Shrey\\.gemini\\antigravity-ide\\brain\\f4b0108e-b4e3-43b4-b449-b5eb232bcffa';
  const defaultScreenshotPath = path.join(artifactDir, 'catalogue_grid_with_photos.png');
  await page.screenshot({ path: defaultScreenshotPath, fullPage: false });
  console.log('Saved screenshot to:', defaultScreenshotPath);

  // Check how many images loaded
  const imgCount = await page.locator('img[alt]').count();
  console.log('Number of images found on catalogue page:', imgCount);

  // Verify sample products are visible
  const cardNames = await page.locator('button p.truncate.text-sm.font-medium').allInnerTexts();
  console.log('First 6 products rendered:', cardNames.slice(0, 6));

  // 4. Click the quick test sample button for "Solitaire Ring"
  console.log('4. Clicking "💍 Solitaire Ring" sample search...');
  const sampleBtn = page.locator('button:has-text("💍 Solitaire Ring")');
  await sampleBtn.click();

  console.log('Waiting for AI similarity search results...');
  await page.waitForSelector('text=Closest catalogue matches', { timeout: 20000 });
  await page.waitForTimeout(3000);

  const searchScreenshotPath = path.join(artifactDir, 'catalogue_ai_similarity_search_results.png');
  await page.screenshot({ path: searchScreenshotPath, fullPage: false });
  console.log('Saved AI search screenshot to:', searchScreenshotPath);

  // Count search results
  const resultCards = await page.locator('span:has-text("#1")').count();
  console.log('AI search results found with rank #1:', resultCards);

  await browser.close();
  console.log('Verification completed successfully!');
}

main().catch((err) => {
  console.error('Error during verification:', err);
  process.exit(1);
});
