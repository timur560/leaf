const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => console.error('Browser page error:', error.message));
  await page.setBypassServiceWorker(true);
  const base = 'http://127.0.0.1:8000/';
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/config.js')) {
      request.respond({ status: 200, contentType: 'application/javascript', body: 'window.LEAF_CONFIG = {};' });
    } else if (request.url().includes('.supabase.co')) {
      request.abort();
    } else {
      request.continue();
    }
  });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });

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
  await page.click('#book-dialog .save-button');
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

  // Check the visible include control reflects the selected tag
  const included = await page.$eval('.tag-filter-choice.include-choice.active', el => el.dataset.tag);
  if (included !== 'Fiction') {
    console.error('The include filter did not activate for Fiction:', included);
    await browser.close();
    process.exit(3);
  }

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

  // Exclude a tag and verify the book matching both filters is hidden
  await page.click('.tag-filter-choice.exclude-choice[data-tag="Adventure"]');
  await new Promise(r => setTimeout(r, 300));
  const excluded = await page.$eval('.tag-filter-choice.exclude-choice.active', el => el.dataset.tag);
  const hiddenByExclusion = await page.evaluate(() => !document.querySelector('#book-grid').innerText.includes('E2E Test Book'));
  if (excluded !== 'Adventure' || !hiddenByExclusion) {
    console.error('The exclude filter did not hide a matching book');
    await browser.close();
    process.exit(5);
  }
  await page.click('#clear-tag-filters');
  await page.waitForFunction(() => document.querySelector('#book-grid').innerText.includes('E2E Test Book'));

  // Seed a small local-only recommendation and gallery fixture.
  await page.evaluate(() => {
    const books = JSON.parse(localStorage.getItem('leaf-library-books-v1') || '[]');
    books.push(
      { id: 'fixture-fiction', title: 'Fiction-only fixture', authors: ['Fixture Author'], tags: ['Fiction'], status: 'want', created_at: new Date().toISOString() },
      { id: 'fixture-adventure', title: 'Adventure-only fixture', authors: ['Fixture Author'], tags: ['Adventure'], status: 'want', created_at: new Date().toISOString() },
      { id: 'fixture-wildcard', title: 'Wildcard fixture', authors: ['Fixture Author'], tags: [], status: 'want', created_at: new Date().toISOString() },
      { id: 'fixture-read', title: 'Already read fixture', authors: ['Fixture Author'], tags: ['Fiction', 'Adventure'], status: 'read', created_at: new Date().toISOString() }
    );
    localStorage.setItem('leaf-library-books-v1', JSON.stringify(books));
    localStorage.setItem('leaf-library-bookshelves-v1', JSON.stringify([
      { id: 'fixture-bookcase', name: 'Fixture bookcase', shelf_count: 2 }
    ]));
  });
  await page.reload({ waitUntil: 'networkidle2' });

  // Existing tag chips in the editor toggle selection without losing typed-tag support.
  await page.evaluate(() => document.querySelector('#book-grid [data-view-book]').click());
  await page.waitForSelector('#book-details-dialog[open]');
  await page.click('[data-edit-from-details]');
  const fictionChip = '.tag-picker-chip[data-draft-tag="Fiction"]';
  await page.click(fictionChip);
  let selectedFiction = await page.$eval(fictionChip, el => el.getAttribute('aria-pressed'));
  if (selectedFiction !== 'false') {
    console.error('Existing tag chip did not remove the selected tag');
    await browser.close();
    process.exit(6);
  }
  await page.click(fictionChip);
  selectedFiction = await page.$eval(fictionChip, el => el.getAttribute('aria-pressed'));
  if (selectedFiction !== 'true') {
    console.error('Existing tag chip did not add the selected tag');
    await browser.close();
    process.exit(7);
  }
  await page.click('#book-dialog [data-close]');

  await page.evaluate(() => document.querySelector('#book-grid [data-view-book="fixture-fiction"]').click());
  await page.waitForSelector('#book-details-dialog[open] [data-details-status]');
  await page.select('[data-details-status="fixture-fiction"]', 'read');
  await page.waitForFunction(() => {
    const books = JSON.parse(localStorage.getItem('leaf-library-books-v1') || '[]');
    return books.find(book => book.id === 'fixture-fiction')?.status === 'read';
  });
  await page.select('[data-details-status="fixture-fiction"]', 'want');
  await page.waitForFunction(() => {
    const books = JSON.parse(localStorage.getItem('leaf-library-books-v1') || '[]');
    return books.find(book => book.id === 'fixture-fiction')?.status === 'want';
  });
  await page.select('[data-details-placement="fixture-fiction"]', 'fixture-bookcase:2');
  await page.waitForFunction(() => {
    const books = JSON.parse(localStorage.getItem('leaf-library-books-v1') || '[]');
    const book = books.find(item => item.id === 'fixture-fiction');
    return book?.status === 'want' &&
      book?.bookshelf_id === 'fixture-bookcase' &&
      Number(book?.bookshelf_shelf) === 2;
  });
  const detailsStatus = await page.$eval('.book-details-status', element => element.textContent);
  const detailsLocation = await page.$eval('.book-details-location strong', element => element.textContent);
  if (detailsStatus !== 'Want to read' || detailsLocation !== 'Fixture bookcase, shelf 2') {
    console.error('Book details quick controls did not update their displayed values:', detailsStatus, detailsLocation);
    await browser.close();
    process.exit(14);
  }
  await page.click('#book-details-dialog [data-close]');

  // Details stay stationary while the page is scrolled; gallery arrows advance horizontally.
  await page.select('#view-select', 'gallery');
  await page.waitForSelector('#gallery-view:not([hidden])');
  const galleryCount = await page.$$eval('#gallery-track .gallery-item', items => items.length);
  if (galleryCount !== 5) {
    console.error('Gallery did not render all filtered books:', galleryCount);
    await browser.close();
    process.exit(8);
  }
  const canAdvanceGallery = await page.$eval('#gallery-next', button => !button.disabled);
  if (!canAdvanceGallery) {
    console.error('Gallery next arrow should be enabled when more books are off-screen');
    await browser.close();
    process.exit(9);
  }
  await page.click('#gallery-next');
  await new Promise(r => setTimeout(r, 500));
  const galleryAdvanced = await page.$eval('#gallery-viewport', element => element.scrollLeft > 0);
  if (!galleryAdvanced) {
    console.error('Gallery arrow did not advance the horizontal viewport');
    await browser.close();
    process.exit(10);
  }
  await page.evaluate(() => window.scrollTo(0, 500));
  await new Promise(r => setTimeout(r, 100));
  const scrollBeforeDetails = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => document.querySelector('#gallery-track [data-view-book]').click());
  const scrollWithDetails = await page.evaluate(() => window.scrollY);
  if (scrollWithDetails !== scrollBeforeDetails) {
    console.error('Opening book details changed the page scroll position:', scrollBeforeDetails, scrollWithDetails);
    await browser.close();
    process.exit(11);
  }
  await page.click('#book-details-dialog [data-close]');
  console.log('Open dialogs before suggestion:', await page.$$eval('dialog[open]', dialogs => dialogs.map(dialog => dialog.id)));

  // Recommendations relax from all selected tags to partial matches, then wildcard books.
  await page.click('#suggest-book');
  console.log('Suggestion dialog state after click:', await page.$eval('#suggest-dialog', dialog => ({ open: dialog.open, hidden: dialog.hidden })));
  await page.waitForSelector('#suggest-dialog[open]');
  console.log('Suggestion tags:', await page.$eval('#suggest-tags', element => element.innerText));
  await page.click('.suggest-tag[data-suggest-tag="Fiction"]');
  await page.click('.suggest-tag[data-suggest-tag="Adventure"]');
  const suggestions = [];
  for (let index = 0; index < 4; index += 1) {
    await page.click('#get-suggestion');
    await page.waitForSelector('#suggest-result:not([hidden]) .suggest-pick');
    suggestions.push(await page.$eval('.suggest-pick-copy h3', element => element.textContent));
    if (index < 3) await page.click('#get-suggestion');
  }
  const uniqueSuggestions = new Set(suggestions);
  if (uniqueSuggestions.size !== 4 || suggestions.includes('Already read fixture')) {
    console.error('Suggestions repeated or included a finished book:', suggestions);
    await browser.close();
    process.exit(12);
  }
  await page.click('#get-suggestion');
  const emptySuggestion = await page.$eval('#suggest-result', element => element.innerText.includes('That’s all for now.'));
  if (!emptySuggestion) {
    console.error('Suggestion dialog did not show its exhausted-library state');
    await browser.close();
    process.exit(13);
  }

  await browser.close();
  console.log('E2E test completed successfully');
  process.exit(0);
})();
