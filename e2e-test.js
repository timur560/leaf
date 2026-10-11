const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  const base = 'http://127.0.0.1:8000/';
  await page.goto(base, { waitUntil: 'networkidle2' });

  // Close any open dialogs (auth dialog may appear if Supabase config present and no session)
  await page.evaluate(() => {
    try {
      document.querySelectorAll('dialog[open]').forEach(d => d.close());
    } catch (e) { /* ignore */ }
  });

  // Open add dialog
  await page.click('#add-book');
  // wait for the title input to be available in the dialog (dialog open may not set attribute in all environments)
  await page.waitForSelector('input[name="title"]', { visible: true });

  // Fill title
  await page.type('input[name="title"]', 'E2E Test Book');

  // Add two authors
  await page.type('#author-input', 'Author One');
  await page.click('#add-author');
  await new Promise(r => setTimeout(r, 200));
  await page.type('#author-input', 'Author Two');
  await page.click('#add-author');
  await new Promise(r => setTimeout(r, 200));

  // Add two tags
  await page.click('#more-details summary');
  await new Promise(r => setTimeout(r, 200));
  await page.type('#tag-input', 'Fiction');
  await page.click('#add-tag');
  await new Promise(r => setTimeout(r, 200));
  await page.type('#tag-input', 'Adventure');
  await page.click('#add-tag');
  await new Promise(r => setTimeout(r, 200));

  // Save
  await page.click('.save-button');
  // Give app a moment to process the save
  await new Promise(r => setTimeout(r, 800));
  const dialogOpen = await page.evaluate(() => !!document.getElementById('book-dialog')?.open);
  const dialogError = await page.evaluate(() => document.getElementById('dialog-error')?.textContent || '');
  console.log('dialogOpen=', dialogOpen, 'dialogError=', dialogError);
  if (dialogOpen) {
    console.error('Dialog remained open after save — aborting. Error:', dialogError);
    await browser.close();
    process.exit(4);
  }

  // Verify book appears in grid
  await page.waitForFunction(() => {
    const grid = document.querySelector('#book-grid');
    return grid && grid.innerText.includes('E2E Test Book');
  }, { timeout: 5000 });
  console.log('Book added and visible in grid');

  // Open Authors view and check authors
  // Open authors view via sidebar filter (more reliable than header button in headless mode)
  await page.click('[data-filter="authors"]');
  await page.waitForSelector('#authors-grid:not([hidden])');
  const authors = await page.$$eval('#authors-grid [data-author]', els => els.map(e => e.getAttribute('data-author')));
  console.log('Authors in directory:', authors);
  if (!authors.includes('Author One') || !authors.includes('Author Two')) {
    console.error('Expected authors not found in authors directory');
    await browser.close();
    process.exit(2);
  }
  console.log('Author directory contains added authors');

  // Return to all books
  await page.click('[data-filter="all"]');
  await page.waitForSelector('#book-grid:not([hidden])');

  // Click a tag chip from the book to apply tag filter
  await page.click('#book-grid .tag-chip');
  await new Promise(r => setTimeout(r, 300));

  // Check selected tag is applied (tag filter count or filtered books)
  const tagFilterCount = await page.$eval('#tag-filter-count', el => el.textContent.trim());
  console.log('Tag filter count display:', tagFilterCount);

  // Ensure filtered results include our book when tag filter applied for the tag it has
  const filteredContains = await page.evaluate(() => {
    const grid = document.querySelector('#book-grid');
    return grid && grid.innerText.includes('E2E Test Book');
  });
  if (!filteredContains) {
    console.error('Filtered view does not contain the book after tag filter');
    await browser.close();
    process.exit(3);
  }
  console.log('Tag filter applied and book remains visible');

  await browser.close();
  console.log('E2E test completed successfully');
  process.exit(0);
})();
