(() => {
  "use strict";

  const STATUS = {
    want: "Want to read",
    reading: "Currently reading",
    read: "Finished"
  };
  const STORAGE_KEY = "leaf-library-books-v1";
  const BOOKSHELVES_KEY = "leaf-library-bookshelves-v1";
  const THEME_KEY = "leaf-library-theme";
  const VIEW_KEY = "leaf-library-view";
  const BOOK_VIEWS = ["compact", "small", "large", "table", "list"];
  const config = window.LEAF_CONFIG || {};
  const remoteEnabled = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const supabase = remoteEnabled && window.supabase
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
    : null;
  const $ = selector => document.querySelector(selector);
  const grid = $("#book-grid");
  const bookDialog = $("#book-dialog");
  const bookForm = $("#book-form");
  const authDialog = $("#auth-dialog");
  const authForm = $("#auth-form");
  const toast = $("#toast");

  let books = [];
  let bookshelves = [];
  let activeFilter = "all";
  let selectedAuthor = "";
  let includedTags = [];
  let excludedTags = [];
  let draftAuthors = [];
  let draftTags = [];
  let suggestionTags = [];
  let suggestedBookIds = new Set();
  let searchTerm = "";
  let editingId = null;
  let coverFile = null;
  let coverPreviewUrl = "";
  let currentUser = null;
  let toastTimer;
  let bookTooltipTimer;
  let bookTooltipPinned = false;
  let isLoading = false;
  let coverObserver = null;
  let coverTransformsSupported = null;
  let coverTransformCheck = null;
  const coverUrlCache = new Map();
  const canEditLibrary = () => remoteEnabled ? Boolean(supabase && currentUser) : true;
  let bookView = BOOK_VIEWS.includes(localStorage.getItem(VIEW_KEY))
    ? localStorage.getItem(VIEW_KEY)
    : "small";

  const localStore = {
    async load() {
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        return Array.isArray(value) ? value : [];
      } catch (error) {
        throw new Error(`Could not read this device's library: ${error.message}`);
      }
    },
    async save(book) {
      const list = await this.load();
      const index = list.findIndex(item => item.id === book.id);
      if (index < 0) list.unshift(book);
      else list[index] = book;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    },
    async remove(id) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify((await this.load()).filter(item => item.id !== id)));
    },
    async loadBookshelves() {
      try {
        const value = JSON.parse(localStorage.getItem(BOOKSHELVES_KEY) || "[]");
        return Array.isArray(value) ? value : [];
      } catch (error) {
        throw new Error(`Could not read this device's bookshelves: ${error.message}`);
      }
    },
    async saveBookshelves(shelves) {
      localStorage.setItem(BOOKSHELVES_KEY, JSON.stringify(shelves));
    }
  };

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function showError(element, error) {
    element.textContent = error?.message || String(error);
    element.hidden = false;
  }

  function clearError(element) {
    element.textContent = "";
    element.hidden = true;
  }

  function safeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function localId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function uniqueNames(values) {
    const names = new Map();
    (Array.isArray(values) ? values : []).forEach(value => {
      const name = String(value || "").trim();
      const key = name.toLocaleLowerCase();
      if (name && !names.has(key)) names.set(key, name);
    });
    return [...names.values()];
  }

  function getBookAuthors(book) {
    return uniqueNames(Array.isArray(book.authors) && book.authors.length ? book.authors : [book.author]);
  }

  function getBookTags(book) {
    return uniqueNames(book.tags);
  }

  function getAuthors() {
    const authors = new Map();
    books.forEach(book => {
      getBookAuthors(book).forEach(name => {
        const key = name.toLocaleLowerCase();
        const author = authors.get(key) || { name, count: 0 };
        author.count += 1;
        authors.set(key, author);
      });
    });
    return [...authors.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function getTags() {
    const tags = new Map();
    books.forEach(book => getBookTags(book).forEach(name => {
      const key = name.toLocaleLowerCase();
      const tag = tags.get(key) || { name, count: 0 };
      tag.count += 1;
      tags.set(key, tag);
    }));
    return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function getFilteredBooks() {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
    return books.filter(book => {
      const matchesStatus = activeFilter === "all" || activeFilter === "authors" ||
        activeFilter === "author-books" || activeFilter === "bookshelves" || book.status === activeFilter;
      const matchesAuthor = activeFilter !== "author-books" ||
        getBookAuthors(book).some(author => author.toLocaleLowerCase() === selectedAuthor.toLocaleLowerCase());
      const bookTags = getBookTags(book).map(tag => tag.toLocaleLowerCase());
      const matchesTags = includedTags.every(tag => bookTags.includes(tag.toLocaleLowerCase())) &&
        !excludedTags.some(tag => bookTags.includes(tag.toLocaleLowerCase()));
      const searchable = [book.title, ...getBookAuthors(book), ...getBookTags(book), book.isbn, book.notes];
      const matchesSearch = !normalizedSearch || searchable
        .some(value => String(value || "").toLocaleLowerCase().includes(normalizedSearch));
      return matchesStatus && matchesAuthor && matchesTags && matchesSearch;
    }).sort((a, b) => {
      switch ($("#sort-select").value) {
        case "title": return a.title.localeCompare(b.title);
        case "author": return a.author.localeCompare(b.author);
        case "year": return (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title);
        default: return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      }
    });
  }

  function renderStatusControl(book) {
    return `<label class="status-control"><span class="sr-only">Reading status for ${safeText(book.title)}</span>
      <select data-status="${safeText(book.id)}" aria-label="Reading status for ${safeText(book.title)}">
        ${Object.entries(STATUS).map(([key, label]) => `<option value="${key}" ${book.status === key ? "selected" : ""}>${safeText(label)}</option>`).join("")}
      </select><span aria-hidden="true">⌄</span>
    </label>`;
  }

  function renderBookTags(tags) {
    return tags.length
      ? `<div class="book-tags">${tags.map(tag => `<button class="tag-chip" type="button" data-tag="${safeText(tag)}" title="Filter by ${safeText(tag)}">${safeText(tag)}</button>`).join("")}</div>`
      : "";
  }

  function renderTagPicker() {
    const available = new Map(getTags().map(tag => [tag.name.toLocaleLowerCase(), tag.name]));
    draftTags.forEach(tag => available.set(tag.toLocaleLowerCase(), tag));
    $("#tag-picker-list").innerHTML = available.size
      ? [...available.values()].sort((a, b) => a.localeCompare(b)).map(tag => {
        const selected = draftTags.some(value => value.toLocaleLowerCase() === tag.toLocaleLowerCase());
        return `<button class="tag-picker-chip${selected ? " selected" : ""}" type="button" data-draft-tag="${safeText(tag)}" aria-pressed="${selected}">${selected ? "✓ " : "+"} ${safeText(tag)}</button>`;
      }).join("")
      : `<span class="tag-picker-empty">Tags you add to your library will appear here.</span>`;
  }

  function renderSuggestionTags() {
    const tags = getTags();
    $("#suggest-tags").innerHTML = tags.length
      ? tags.map(tag => {
        const selected = suggestionTags.some(value => value.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
        return `<button class="suggest-tag${selected ? " selected" : ""}" type="button" data-suggest-tag="${safeText(tag.name)}" aria-pressed="${selected}"><span>${selected ? "✓" : "+"}</span>${safeText(tag.name)}<small>${tag.count}</small></button>`;
      }).join("")
      : `<p class="suggest-no-tags">Your library has no tags yet. We can still find a lovely next read.</p>`;
  }

  function getSignedCoverUrl(path, optimize = false) {
    const cacheKey = `${optimize ? "thumbnail" : "original"}:${path}`;
    const cached = coverUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const entry = {
      expiresAt: Date.now() + 55 * 60 * 1000,
      promise: supabase.storage.from("book-covers").createSignedUrl(path, 3600, optimize ? {
        transform: { width: 420, height: 560, resize: "contain", quality: 70 }
      } : undefined)
        .then(({ data, error }) => {
          if (error) throw error;
          if (!data?.signedUrl) throw new Error("Supabase did not return a signed cover URL.");
          return data.signedUrl;
        })
        .catch(error => {
          coverUrlCache.delete(cacheKey);
          throw error;
        })
    };
    coverUrlCache.set(cacheKey, entry);
    return entry.promise;
  }

  function supportsCoverTransforms(path) {
    if (coverTransformsSupported !== null) return Promise.resolve(coverTransformsSupported);
    if (!coverTransformCheck) {
      coverTransformCheck = getSignedCoverUrl(path, true).then(url => new Promise(resolve => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = url;
      })).catch(() => false).then(supported => {
        coverTransformsSupported = supported;
        return supported;
      });
    }
    return coverTransformCheck;
  }

  async function getDisplayCoverUrl(path) {
    const optimize = await supportsCoverTransforms(path);
    return getSignedCoverUrl(path, optimize);
  }

  async function loadCoverImage(image) {
    const path = image.dataset.coverPath;
    if (!path) return;
    try {
      const url = await getDisplayCoverUrl(path);
      if (image.isConnected && image.dataset.coverPath === path) image.src = url;
    } catch (error) {
      notify(`Could not load cover: ${error.message}`);
    }
  }

  function observeBookCovers() {
    const images = document.querySelectorAll("#book-grid img[data-cover-path]");
    if (!images.length) return;
    if (!("IntersectionObserver" in window)) {
      images.forEach(image => loadCoverImage(image));
      return;
    }
    if (!coverObserver) {
      coverObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          coverObserver.unobserve(entry.target);
          loadCoverImage(entry.target);
        });
      }, { rootMargin: "250px 0px" });
    }
    images.forEach(image => coverObserver.observe(image));
  }

  function renderBookshelfBook(book, index) {
    const spineColors = ["fern", "terracotta", "ochre", "ink", "moss", "rose"];
    const height = 112 + Array.from(book.id || book.title).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 36;
    const tag = canEditLibrary() ? "button" : "div";
    const buttonAttributes = canEditLibrary() ? 'type="button" draggable="true"' : 'role="group" tabindex="0"';
    return `<${tag} class="bookshelf-book spine-${spineColors[index % spineColors.length]}" ${buttonAttributes}
      data-book-id="${safeText(book.id)}" data-shelf-book
      style="--spine-height:${height}px" aria-label="${safeText(book.title)} by ${safeText(getBookAuthors(book).join(", "))}">
      <span class="book-spine-title">${safeText(book.title)}</span>
    </${tag}>`;
  }

  function renderBookshelves(filteredBooks) {
    const shelfView = $("#bookshelves-view");
    const list = $("#bookshelf-list");
    list.innerHTML = bookshelves.length ? bookshelves.map(bookshelf => {
      const shelfCount = Math.max(2, Number(bookshelf.shelf_count) || 2);
      const shelvesMarkup = Array.from({ length: shelfCount }, (_, index) => {
        const shelfNumber = index + 1;
        const shelfBooks = filteredBooks.filter(book =>
          book.bookshelf_id === bookshelf.id &&
          Number(book.bookshelf_shelf) === shelfNumber
        );
        return `<section class="bookshelf-shelf">
          <div class="shelf-label-row"><span>SHELF ${shelfNumber}</span><span>${shelfBooks.length} ${shelfBooks.length === 1 ? "book" : "books"}</span></div>
          <div class="shelf-drop-zone" data-drop-kind="shelf" data-bookshelf-id="${safeText(bookshelf.id)}" data-shelf-number="${shelfNumber}" aria-label="Drop books on ${safeText(bookshelf.name)}, shelf ${shelfNumber}">
            <div class="shelf-books">${shelfBooks.map(renderBookshelfBook).join("")}</div>
            ${shelfBooks.length ? "" : `<span class="shelf-empty-hint">Drop a book here</span>`}
            <div class="shelf-board" aria-hidden="true"></div>
          </div>
        </section>`;
      }).join("");
      return `<article class="bookshelf-case">
        <header class="bookshelf-case-heading">
          <div><span class="bookshelf-case-mark" aria-hidden="true">▤</span><div><h3>${safeText(bookshelf.name)}</h3><small>${shelfCount} ${shelfCount === 1 ? "shelf" : "shelves"}</small></div></div>
          ${canEditLibrary() ? `<div class="bookshelf-case-actions">
            <button class="secondary-button add-shelf-button" type="button" data-add-shelf="${safeText(bookshelf.id)}">＋ Add shelf</button>
            <button class="bookshelf-delete" type="button" data-delete-bookshelf="${safeText(bookshelf.id)}" aria-label="Delete ${safeText(bookshelf.name)}">×</button>
          </div>` : ""}
        </header>
        <div class="bookshelf-frame">${shelvesMarkup}</div>
      </article>`;
    }).join("") : `<div class="bookshelves-empty"><span aria-hidden="true">▤</span><h3>Your shelves are ready to be built.</h3><p>Create a bookshelf to give your books a home. Every bookcase starts with two shelves.</p></div>`;

    const unassigned = filteredBooks.filter(book => {
      const bookshelf = bookshelves.find(item => item.id === book.bookshelf_id);
      return !bookshelf || !Number.isInteger(Number(book.bookshelf_shelf)) ||
        Number(book.bookshelf_shelf) < 1 ||
        Number(book.bookshelf_shelf) > Math.max(2, Number(bookshelf.shelf_count) || 2);
    });
    $("#floor-count").textContent = unassigned.length;
    $("#floor-books").innerHTML = unassigned.map(renderBookshelfBook).join("");
    $("#book-floor").classList.toggle("has-floor-books", unassigned.length > 0);
    shelfView.classList.toggle("has-bookshelves", bookshelves.length > 0);
  }

  function showBookTooltip(bookElement) {
    const book = books.find(item => item.id === bookElement.dataset.bookId);
    if (!book) return;
    const tooltip = $("#book-tooltip");
    const authors = getBookAuthors(book).join(", ");
    const coverMarkup = book.cover_data
      ? `<img class="book-tooltip-cover" src="${safeText(book.cover_data)}" alt="Cover of ${safeText(book.title)}">`
      : book.cover_url
        ? `<img class="book-tooltip-cover" src="${safeText(book.cover_url)}" alt="Cover of ${safeText(book.title)}">`
        : book.cover_path && supabase
          ? `<img class="book-tooltip-cover" data-tooltip-cover="${safeText(book.cover_path)}" alt="Cover of ${safeText(book.title)}">`
          : `<span class="book-tooltip-cover-placeholder" aria-hidden="true">▤</span>`;
    const shelfOptions = bookshelves.map(bookshelf => {
      const shelfCount = Math.max(2, Number(bookshelf.shelf_count) || 2);
      return `<optgroup label="${safeText(bookshelf.name)}">${Array.from({ length: shelfCount }, (_, index) => {
        const shelfNumber = index + 1;
        const selected = book.bookshelf_id === bookshelf.id && Number(book.bookshelf_shelf) === shelfNumber;
        return `<option value="${safeText(bookshelf.id)}:${shelfNumber}" ${selected ? "selected" : ""}>Shelf ${shelfNumber}</option>`;
      }).join("")}</optgroup>`;
    }).join("");
    const placementMarkup = canEditLibrary()
      ? `<label>Move to<select data-tooltip-placement="${safeText(book.id)}"><option value="floor" ${book.bookshelf_id ? "" : "selected"}>Waiting on the floor</option>${shelfOptions}</select></label>`
      : `<button class="book-details-link" type="button" data-view-book="${safeText(book.id)}">View all details</button>`;
    tooltip.innerHTML = `<div class="book-tooltip-content">${coverMarkup}<div class="book-tooltip-copy"><strong>${safeText(book.title)}</strong><span>${safeText(authors)}</span>${placementMarkup}</div></div>`;
    tooltip.hidden = false;
    const rect = bookElement.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - tooltipRect.width / 2, window.innerWidth - tooltipRect.width - 12));
    const top = rect.top - tooltipRect.height - 12 > 8 ? rect.top - tooltipRect.height - 12 : rect.bottom + 12;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.min(top, window.innerHeight - tooltipRect.height - 8)}px`;
    const cover = tooltip.querySelector("[data-tooltip-cover]");
    if (cover) {
      getDisplayCoverUrl(cover.dataset.tooltipCover).then(url => {
        if (cover.isConnected) cover.src = url;
      }).catch(error => notify(`Could not load cover: ${error.message}`));
    }
  }

  function render() {
    bookTooltipPinned = false;
    $("#book-tooltip").hidden = true;
    const filtered = getFilteredBooks();
    const authors = getAuthors();
    const tags = getTags();
    const authorDirectory = activeFilter === "authors";
    const bookshelfView = activeFilter === "bookshelves";
    const authorBooks = activeFilter === "author-books";
    const canEdit = canEditLibrary();
    $("#add-book").hidden = !canEdit;
    $("#add-bookshelf").hidden = !canEdit;
    $("#mobile-account-button").hidden = !supabase;
    $("#mobile-account-button").textContent = currentUser ? "Account" : "Sign in";
    $("#account-name").textContent = currentUser?.email?.split("@")[0] || (supabase ? "Public library" : "My library");
    $("#account-mode").textContent = currentUser ? "Owner · can edit" :
      supabase ? "Read-only · sign in to edit" : "This device only";
    $("#sign-out").hidden = !currentUser;
    $("#author-suggestions").innerHTML = authors
      .map(author => `<option value="${safeText(author.name)}"></option>`).join("");
    $("#tag-suggestions").innerHTML = tags
      .map(tag => `<option value="${safeText(tag.name)}"></option>`).join("");
    $("#tag-filter-options").innerHTML = tags.length ? tags.map(tag => {
      const included = includedTags.some(selected => selected.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
      const excluded = excludedTags.some(selected => selected.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
      return `<div class="tag-filter-option">
        <span class="tag-filter-name">${safeText(tag.name)}<small>${tag.count}</small></span>
        <button type="button" class="tag-filter-choice include-choice${included ? " active" : ""}" data-tag-filter="include" data-tag="${safeText(tag.name)}" aria-pressed="${included}" aria-label="Include ${safeText(tag.name)}">+</button>
        <button type="button" class="tag-filter-choice exclude-choice${excluded ? " active" : ""}" data-tag-filter="exclude" data-tag="${safeText(tag.name)}" aria-pressed="${excluded}" aria-label="Exclude ${safeText(tag.name)}">−</button>
      </div>`;
    }).join("") : `<p class="no-tags">Add tags to books to use tag filters.</p>`;
    $("#clear-tag-filters").hidden = !includedTags.length && !excludedTags.length;
    $("#tag-filter-panel").hidden = authorDirectory || bookshelfView;
    $("#view-select").value = bookView;
    $("#view-select").closest(".view-select").hidden = authorDirectory || bookshelfView;
    $("#sort-select").closest(".sort-select").hidden = authorDirectory || bookshelfView;
    $("#count-authors").textContent = authors.length;
    $("#count-bookshelves").textContent = bookshelves.length;
    $("#loading-state").hidden = !isLoading;
    $("#authors-grid").hidden = isLoading || !authorDirectory;
    $("#authors-grid").innerHTML = authorDirectory ? authors
      .filter(author => !searchTerm.trim() || author.name.toLocaleLowerCase().includes(searchTerm.trim().toLocaleLowerCase()))
      .map(author => `<button class="author-card" type="button" data-author="${safeText(author.name)}">
        <span class="author-avatar" aria-hidden="true">${safeText(author.name.trim().charAt(0).toLocaleUpperCase())}</span>
        <span class="author-card-copy"><strong>${safeText(author.name)}</strong><small>${author.count} ${author.count === 1 ? "book" : "books"}</small></span>
        <span class="author-arrow" aria-hidden="true">↗</span>
      </button>`).join("") : "";
    const visibleAuthors = authorDirectory
      ? authors.filter(author => !searchTerm.trim() || author.name.toLocaleLowerCase().includes(searchTerm.trim().toLocaleLowerCase()))
      : [];
    $("#bookshelves-view").hidden = isLoading || !bookshelfView;
    renderBookshelves(filtered);
    grid.dataset.view = bookView;
    grid.hidden = isLoading || authorDirectory || bookshelfView || filtered.length === 0;
    const bookMarkup = filtered.map(book => {
      const initial = safeText((book.title || "?").trim().charAt(0).toLocaleUpperCase());
      const gradient = ["sage", "rose", "ochre", "blue"][Array.from(book.title || "").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4];
      const image = book.cover_url
        ? `<img src="${safeText(book.cover_url)}" alt="" loading="lazy" decoding="async">`
        : `<div class="cover-placeholder ${gradient}"><span class="cover-initial">${initial}</span><span class="cover-spine"></span></div>${
          supabase && book.cover_path
            ? `<img data-cover-path="${safeText(book.cover_path)}" alt="" loading="lazy" decoding="async">`
            : ""
        }`;
      const detailLine = [book.year, book.pages ? `${book.pages} pages` : ""].filter(Boolean).join(" · ");
      const authorsLabel = getBookAuthors(book).join(", ");
      const bookTags = getBookTags(book);
      const cover = `<button class="book-cover" type="button" data-view-book="${safeText(book.id)}" aria-label="View details for ${safeText(book.title)}">
        ${image}<span class="status-badge status-${safeText(book.status || "want")}">${safeText(STATUS[book.status] || STATUS.want)}</span>
      </button>`;
      const statusControl = canEdit ? renderStatusControl(book) : "";
      if (bookView === "table") {
        return `<tr>
          <td><button class="table-book-title" type="button" data-view-book="${safeText(book.id)}">${safeText(book.title)}</button></td>
          <td>${safeText(authorsLabel)}</td>
          <td>${safeText(book.year || "—")}</td>
          <td>${safeText(book.pages || "—")}</td>
          <td>${renderBookTags(bookTags)}</td>
          <td>${canEdit ? statusControl : safeText(STATUS[book.status] || STATUS.want)}</td>
        </tr>`;
      }
      if (bookView === "list") {
        return `<article class="book-card list-book-card">
          ${cover}
          <div class="book-card-body">
            <h3 title="${safeText(book.title)}">${safeText(book.title)}</h3>
            <p class="book-author" title="${safeText(authorsLabel)}">${safeText(authorsLabel)}</p>
            <p class="book-meta${detailLine ? "" : " muted-meta"}">${safeText(detailLine || "Add book details ↗")}</p>
            ${renderBookTags(bookTags)}
          </div>
          <div class="list-book-status">${statusControl}</div>
        </article>`;
      }
      return `<article class="book-card">
        ${cover}
        <div class="book-card-body">
          <h3 title="${safeText(book.title)}">${safeText(book.title)}</h3>
          <p class="book-author" title="${safeText(authorsLabel)}">${safeText(authorsLabel)}</p>
          ${detailLine ? `<p class="book-meta">${safeText(detailLine)}</p>` : `<p class="book-meta muted-meta">Add book details ↗</p>`}
          ${renderBookTags(bookTags)}
          ${statusControl}
        </div>
      </article>`;
    }).join("");
    if (coverObserver) coverObserver.disconnect();
    grid.innerHTML = bookView === "table"
      ? `<div class="book-table-wrap"><table class="book-table">
          <thead><tr><th scope="col">Title</th><th scope="col">Authors</th><th scope="col">Year</th><th scope="col">Pages</th><th scope="col">Tags</th><th scope="col">Status</th></tr></thead>
          <tbody>${bookMarkup}</tbody>
        </table></div>`
      : bookMarkup;
    if (bookView !== "table") observeBookCovers();

    const count = books.length;
    $("#count-all").textContent = count;
    $("#count-reading").textContent = books.filter(book => book.status === "reading").length;
    $("#count-read").textContent = books.filter(book => book.status === "read").length;
    $("#count-want").textContent = books.filter(book => book.status === "want").length;
    $("#stat-total").textContent = count;
    $("#stat-read").textContent = books.filter(book => book.status === "read").length;
    $("#results-label").textContent = authorDirectory
      ? `${visibleAuthors.length} ${visibleAuthors.length === 1 ? "author" : "authors"}`
      : `${filtered.length} ${filtered.length === 1 ? "book" : "books"}`;
    $("#section-title").textContent = authorDirectory ? "All authors" : authorBooks ? selectedAuthor :
      bookshelfView ? "Bookshelves" : activeFilter === "all" ? "Your collection" : STATUS[activeFilter] === "Finished" ? "Finished books" : STATUS[activeFilter];
    $("#view-title").textContent = authorDirectory ? "Authors" : authorBooks ? selectedAuthor :
      bookshelfView ? "Bookshelves" : activeFilter === "all" ? "All books" : STATUS[activeFilter];
    const noMatch = authorDirectory ? visibleAuthors.length === 0 : filtered.length === 0;
    $("#empty-state").hidden = isLoading || bookshelfView || !noMatch;
    $("#empty-title").textContent = authorDirectory
      ? (authors.length && searchTerm ? "No authors found." : "No authors yet.")
      : count > 0 ? "No books found." : "Your shelves are waiting.";
    $("#empty-copy").textContent = authorDirectory
      ? (authors.length && searchTerm ? "Try another search to find an author." : "Authors will appear here as you add books to your library.")
      : count > 0
        ? "Try another search, change the tag filters, or choose a different shelf."
        : "Start with a title and author. You can fill in the rest whenever you like.";
    $("#empty-add").hidden = !canEdit || authorDirectory || count > 0 || activeFilter !== "all";
    $("#sort-select").closest(".sort-select").hidden = authorDirectory || bookshelfView;
    const currentBook = books.find(book => book.status === "reading");
    $("#reading-card").hidden = !currentBook || activeFilter !== "all";
    if (currentBook) {
      $("#reading-title").textContent = currentBook.title;
      $("#reading-author").textContent = `by ${getBookAuthors(currentBook).join(", ")}`;
      $("#continue-reading").dataset.viewBook = currentBook.id;
    }
    $("#continue-reading").hidden = !canEdit;
    document.querySelectorAll("[data-filter]").forEach(button => {
      button.classList.toggle("active", button.dataset.filter === activeFilter ||
        (activeFilter === "author-books" && button.dataset.filter === "authors"));
    });
  }

  function activateFilter(filter) {
    activeFilter = filter;
    selectedAuthor = "";
    if (filter === "authors" || filter === "bookshelves") {
      includedTags = [];
      excludedTags = [];
    }
    render();
  }

  function showAuthorBooks(name) {
    selectedAuthor = name;
    activeFilter = "author-books";
    searchTerm = "";
    $("#search-input").value = "";
    render();
  }

  function openBookDetails(id) {
    const book = books.find(item => item.id === id);
    if (!book) return;
    const bookshelf = bookshelves.find(item => item.id === book.bookshelf_id);
    const shelfNumber = Number(book.bookshelf_shelf);
    const shelfLabel = bookshelf && Number.isInteger(shelfNumber) && shelfNumber > 0
      ? `${bookshelf.name}, shelf ${shelfNumber}`
      : "Waiting on the floor";
    const coverMarkup = book.cover_data || book.cover_url
      ? `<img class="book-details-cover" src="${safeText(book.cover_data || book.cover_url)}" alt="Cover of ${safeText(book.title)}">`
      : book.cover_path && supabase
        ? `<img class="book-details-cover" data-book-detail-cover="${safeText(book.cover_path)}" alt="Cover of ${safeText(book.title)}">`
        : `<div class="book-details-cover book-details-cover-placeholder" aria-hidden="true">▤</div>`;
    const details = [
      ["Authors", getBookAuthors(book).join(", ")],
    ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
    const metadata = [
      ["Published", book.year],
      ["Pages", book.pages],
      ["ISBN", book.isbn]
    ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
    const tags = getBookTags(book);
    const editButton = canEditLibrary()
      ? `<button class="book-details-edit" type="button" data-edit-from-details="${safeText(book.id)}" aria-label="Edit ${safeText(book.title)}" title="Edit book">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
        </button>`
      : "";
    const quickControls = canEditLibrary()
      ? `<div class="book-details-quick-controls">
          <label><span>READING STATUS</span><select data-details-status="${safeText(book.id)}" aria-label="Reading status for ${safeText(book.title)}">
            ${Object.entries(STATUS).map(([key, label]) => `<option value="${key}" ${book.status === key ? "selected" : ""}>${safeText(label)}</option>`).join("")}
          </select></label>
          <label><span>BOOKSHELF / BOOKCASE</span><select data-details-placement="${safeText(book.id)}" aria-label="Bookshelf or bookcase for ${safeText(book.title)}">
            <option value="floor" ${book.bookshelf_id ? "" : "selected"}>Waiting on the floor</option>
            ${bookshelves.map(shelf => {
              const shelfCount = Math.max(2, Number(shelf.shelf_count) || 2);
              return `<optgroup label="${safeText(shelf.name)}">${Array.from({ length: shelfCount }, (_, index) => {
                const number = index + 1;
                const selected = book.bookshelf_id === shelf.id && Number(book.bookshelf_shelf) === number;
                return `<option value="${safeText(shelf.id)}:${number}" ${selected ? "selected" : ""}>Shelf ${number}</option>`;
              }).join("")}</optgroup>`;
            }).join("")}
          </select></label>
        </div>`
      : "";
    $("#book-details-content").innerHTML = `<div class="book-details-layout">
      <div class="book-details-art">${coverMarkup}<span class="book-details-status status-${safeText(book.status || "want")}">${safeText(STATUS[book.status] || STATUS.want)}</span></div>
      <div class="book-details-copy">
        <div class="book-details-heading"><span class="eyebrow">FROM YOUR LIBRARY</span>${editButton}</div>
        <h2 id="book-details-title">${safeText(book.title)}</h2>
        <p class="book-details-authors">${details.map(([, value]) => safeText(value)).join(", ")}</p>
        ${quickControls}
        ${metadata.length ? `<div class="book-details-metadata">${metadata.map(([label, value]) => `<div><span>${safeText(label)}</span><strong>${safeText(value)}</strong></div>`).join("")}</div>` : ""}
        ${tags.length ? `<div class="book-details-tags" aria-label="Tags">${tags.map(tag => `<span>${safeText(tag)}</span>`).join("")}</div>` : ""}
        <div class="book-details-location"><span class="book-details-location-icon" aria-hidden="true">⌂</span><div><small>BOOKSHELF</small><strong>${safeText(shelfLabel)}</strong></div></div>
        ${book.notes ? `<section class="book-details-notes"><span class="eyebrow">YOUR NOTES</span><p>${safeText(book.notes)}</p></section>` : ""}
      </div>
    </div>`;
    const dialog = $("#book-details-dialog");
    dialog.dataset.bookId = book.id;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    const cover = $("#book-details-content [data-book-detail-cover]");
    if (cover) {
      getDisplayCoverUrl(cover.dataset.bookDetailCover).then(url => {
        if (cover.isConnected) cover.src = url;
      }).catch(error => notify(`Could not load cover: ${error.message}`));
    }
  }

  function renderSelectedChips(container, values, kind) {
    container.innerHTML = values.map((value, index) =>
      `<span class="selected-chip">${safeText(value)}<button type="button" data-remove-${kind}="${index}" aria-label="Remove ${safeText(value)}">×</button></span>`
    ).join("");
  }

  function addDraftValue(kind) {
    const isAuthor = kind === "author";
    const input = isAuthor ? $("#author-input") : $("#tag-input");
    const values = isAuthor ? draftAuthors : draftTags;
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    if (!values.some(existing => existing.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      values.push(value);
      renderSelectedChips(isAuthor ? $("#selected-authors") : $("#selected-tags"), values, kind);
      if (!isAuthor) renderTagPicker();
    }
    input.value = "";
    clearError($("#dialog-error"));
    input.focus();
  }

  function setDraftValues(kind, values) {
    const isAuthor = kind === "author";
    const unique = uniqueNames(values);
    if (isAuthor) draftAuthors = unique;
    else draftTags = unique;
    renderSelectedChips(isAuthor ? $("#selected-authors") : $("#selected-tags"), unique, kind);
    if (!isAuthor) renderTagPicker();
  }

  function removeDraftValue(kind, index) {
    const values = kind === "author" ? draftAuthors : draftTags;
    values.splice(index, 1);
    setDraftValues(kind, values);
  }

  function openSuggestionDialog() {
    suggestionTags = [];
    suggestedBookIds = new Set();
    $("#suggest-result").hidden = true;
    $("#suggest-result").innerHTML = "";
    renderSuggestionTags();
    $("#suggest-dialog").showModal();
  }

  function showSuggestion() {
    const candidates = books.filter(book => book.status !== "read" && !suggestedBookIds.has(String(book.id)));
    const result = $("#suggest-result");
    if (!candidates.length) {
      result.innerHTML = `<div class="suggest-empty"><span aria-hidden="true">✧</span><h3>That’s all for now.</h3><p>You’ve explored every unread book in your library. Add another book or mark something as unread to keep the magic going.</p></div>`;
      result.hidden = false;
      return;
    }
    const ranked = candidates.map(book => {
      const bookTags = getBookTags(book).map(tag => tag.toLocaleLowerCase());
      return {
        book,
        matches: suggestionTags.filter(tag => bookTags.includes(tag.toLocaleLowerCase())).length,
      };
    });
    const highestMatchCount = ranked.reduce((highest, item) => Math.max(highest, item.matches), 0);
    const best = ranked.filter(item => item.matches === highestMatchCount);
    const { book } = best[Math.floor(Math.random() * best.length)];
    suggestedBookIds.add(String(book.id));
    const coverMarkup = book.cover_data || book.cover_url
      ? `<img src="${safeText(book.cover_data || book.cover_url)}" alt="">`
      : book.cover_path && supabase
        ? `<img data-suggest-cover="${safeText(book.cover_path)}" alt="">`
        : `<div class="suggest-cover-placeholder" aria-hidden="true"><span>✦</span></div>`;
    const matchCopy = suggestionTags.length
      ? highestMatchCount === suggestionTags.length
        ? "A perfect match for every mood you picked"
        : highestMatchCount > 1
          ? `A lovely match for ${highestMatchCount} of your selected tags`
          : highestMatchCount === 1
            ? "A little something that matches your mood"
            : "A fresh possibility from your unread shelf"
      : "A little inspiration from your unread shelf";
    result.innerHTML = `<article class="suggest-pick">
      <div class="suggest-pick-cover">${coverMarkup}</div>
      <div class="suggest-pick-copy"><span class="eyebrow">${safeText(matchCopy)}</span><h3>${safeText(book.title)}</h3><p>by ${safeText(getBookAuthors(book).join(", "))}</p>
        ${getBookTags(book).length ? `<div class="suggest-pick-tags">${getBookTags(book).map(tag => `<span>${safeText(tag)}</span>`).join("")}</div>` : ""}
        <button type="button" class="suggest-view-book" data-view-book="${safeText(book.id)}">Meet this book <span>↗</span></button>
      </div>
    </article>`;
    result.hidden = false;
    result.classList.remove("is-revealing");
    void result.offsetWidth;
    result.classList.add("is-revealing");
    const cover = result.querySelector("[data-suggest-cover]");
    if (cover) {
      getDisplayCoverUrl(cover.dataset.suggestCover).then(url => {
        if (cover.isConnected) cover.src = url;
      }).catch(error => notify(`Could not load cover: ${error.message}`));
    }
    const confetti = $("#suggest-confetti");
    confetti.innerHTML = Array.from({ length: 28 }, (_, index) =>
      `<i style="--i:${index};--x:${Math.round(Math.random() * 100)}%;--h:${Math.round(Math.random() * 360)}deg;--dx:${(index - 14) * 8}px;--dy:${110 + (index % 4) * 16}px;--delay:${index * 14}ms;--rotation:${index * 37}deg" aria-hidden="true"></i>`
    ).join("");
    confetti.classList.remove("celebrate");
    void confetti.offsetWidth;
    confetti.classList.add("celebrate");
  }

  async function loadBooks() {
    isLoading = true;
    render();
    try {
      if (!supabase) {
        [books, bookshelves] = await Promise.all([localStore.load(), localStore.loadBookshelves()]);
        $("#sync-status").textContent = "SAVED ON THIS DEVICE";
        $("#account-mode").textContent = "This device only";
        return;
      }
      const [bookResult, bookshelfResult] = await Promise.all([
        supabase.from("books").select("*").order("created_at", { ascending: false }),
        supabase.from("bookshelves").select("*").order("created_at", { ascending: true })
      ]);
      if (bookResult.error) throw bookResult.error;
      if (bookshelfResult.error) throw bookshelfResult.error;
      books = bookResult.data || [];
      bookshelves = bookshelfResult.data || [];
      $("#sync-status").textContent = "SYNCED WITH SUPABASE";
    } finally {
      isLoading = false;
      render();
    }
  }

  function setUser(user) {
    currentUser = user;
    $("#account-name").textContent = user?.email?.split("@")[0] || "My library";
    $("#avatar").textContent = (user?.email?.charAt(0) || "G").toLocaleUpperCase();
    $("#account-mode").textContent = user ? "Owner · can edit" :
      supabase ? "Read-only · sign in to edit" : "This device only";
    if (!user) {
      coverUrlCache.clear();
      render();
    } else if (authDialog.open) authDialog.close();
  }

  async function saveBookshelfPlacement(bookId, bookshelfId, shelfNumber) {
    if (!canEditLibrary()) throw new Error("Sign in as the library owner to move books.");
    const book = books.find(item => item.id === bookId);
    if (!book) throw new Error("That book is no longer in your library.");
    if (bookshelfId) {
      const bookshelf = bookshelves.find(item => item.id === bookshelfId);
      if (!bookshelf || !Number.isInteger(shelfNumber) ||
          shelfNumber < 1 || shelfNumber > Math.max(2, Number(bookshelf.shelf_count) || 2)) {
        throw new Error("Choose a valid shelf for this book.");
      }
    } else {
      shelfNumber = null;
    }

    const placement = { bookshelf_id: bookshelfId, bookshelf_shelf: shelfNumber };
    if (supabase) {
      const { error } = await supabase.from("books").update(placement).eq("id", bookId);
      if (error) throw error;
    } else {
      await localStore.save({ ...book, ...placement });
    }
    books = books.map(item => item.id === bookId ? { ...item, ...placement } : item);
    render();
    refreshBookDetailsQuickControls(books.find(item => item.id === bookId));
  }

  function refreshBookDetailsQuickControls(book) {
    const dialog = $("#book-details-dialog");
    if (!book || dialog.dataset.bookId !== book.id) return;
    const status = dialog.querySelector(".book-details-status");
    if (status) {
      status.className = `book-details-status status-${book.status || "want"}`;
      status.textContent = STATUS[book.status] || STATUS.want;
    }
    const statusSelect = dialog.querySelector("[data-details-status]");
    if (statusSelect) statusSelect.value = book.status || "want";
    const placementSelect = dialog.querySelector("[data-details-placement]");
    if (placementSelect) {
      placementSelect.value = book.bookshelf_id
        ? `${book.bookshelf_id}:${Number(book.bookshelf_shelf)}`
        : "floor";
    }
    const bookshelf = bookshelves.find(item => item.id === book.bookshelf_id);
    const shelfNumber = Number(book.bookshelf_shelf);
    const shelfLabel = bookshelf && Number.isInteger(shelfNumber) && shelfNumber > 0
      ? `${bookshelf.name}, shelf ${shelfNumber}`
      : "Waiting on the floor";
    const location = dialog.querySelector(".book-details-location strong");
    if (location) location.textContent = shelfLabel;
  }

  async function createBookshelf(event) {
    event.preventDefault();
    if (!canEditLibrary()) {
      showError($("#bookshelf-error"), new Error("Sign in as the library owner to manage bookshelves."));
      return;
    }
    const form = $("#bookshelf-form");
    const submit = form.querySelector('[type="submit"]');
    const errorElement = $("#bookshelf-error");
    submit.disabled = true;
    clearError(errorElement);
    try {
      const name = String(new FormData(form).get("name") || "").trim();
      if (!name) throw new Error("Enter a name for this bookshelf.");
      if (bookshelves.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new Error("A bookshelf with this name already exists.");
      }
      let bookshelf = { id: localId(), name, shelf_count: 2, created_at: new Date().toISOString() };
      if (supabase) {
        const { data, error } = await supabase.from("bookshelves")
          .insert({ name, shelf_count: 2 }).select().single();
        if (error) throw error;
        bookshelf = data;
      } else {
        await localStore.saveBookshelves([...bookshelves, bookshelf]);
      }
      bookshelves = [...bookshelves, bookshelf];
      form.reset();
      $("#bookshelf-dialog").close();
      render();
      notify(`“${name}” bookshelf created with two shelves.`);
    } catch (error) {
      showError(errorElement, error);
    } finally {
      submit.disabled = false;
    }
  }

  async function addBookshelfShelf(bookshelfId) {
    if (!canEditLibrary()) return;
    const bookshelf = bookshelves.find(item => item.id === bookshelfId);
    if (!bookshelf) return;
    const updated = { ...bookshelf, shelf_count: Math.max(2, Number(bookshelf.shelf_count) || 2) + 1 };
    try {
      if (supabase) {
        const { error } = await supabase.from("bookshelves").update({ shelf_count: updated.shelf_count })
          .eq("id", bookshelfId);
        if (error) throw error;
      } else {
        await localStore.saveBookshelves(bookshelves.map(item => item.id === bookshelfId ? updated : item));
      }
      bookshelves = bookshelves.map(item => item.id === bookshelfId ? updated : item);
      render();
      notify(`Added a shelf to “${bookshelf.name}”.`);
    } catch (error) {
      notify(`Could not add shelf: ${error.message}`);
    }
  }

  async function deleteBookshelf(bookshelfId) {
    if (!canEditLibrary()) return;
    const bookshelf = bookshelves.find(item => item.id === bookshelfId);
    if (!bookshelf || !confirm(`Remove “${bookshelf.name}”? Its books will be moved to the floor.`)) return;
    try {
      const movedBooks = books.filter(book => book.bookshelf_id === bookshelfId)
        .map(book => ({ ...book, bookshelf_id: null, bookshelf_shelf: null }));
      if (supabase) {
        const { error: updateError } = await supabase.from("books")
          .update({ bookshelf_id: null, bookshelf_shelf: null }).eq("bookshelf_id", bookshelfId);
        if (updateError) throw updateError;
        const { error: deleteError } = await supabase.from("bookshelves").delete().eq("id", bookshelfId);
        if (deleteError) throw deleteError;
      } else {
        for (const book of movedBooks) await localStore.save(book);
        await localStore.saveBookshelves(bookshelves.filter(item => item.id !== bookshelfId));
      }
      books = books.map(book => book.bookshelf_id === bookshelfId
        ? { ...book, bookshelf_id: null, bookshelf_shelf: null }
        : book);
      bookshelves = bookshelves.filter(item => item.id !== bookshelfId);
      render();
      notify(`“${bookshelf.name}” removed; its books are now on the floor.`);
    } catch (error) {
      try {
        await loadBooks();
      } catch (refreshError) {
        notify(`Could not refresh the library after removal failed: ${refreshError.message}`);
      }
      notify(`Could not remove bookshelf: ${error.message}`);
    }
  }

  function resetForm() {
    bookForm.reset();
    $("#more-details").open = false;
    $("#cover-preview").textContent = "▧";
    $("#cover-preview").style.backgroundImage = "";
    $("#cover-label").textContent = "Add a cover photo";
    $("#delete-book").hidden = true;
    $("#form-title").innerHTML = "Add a book<span class=\"heading-dot\">.</span>";
    $("#form-eyebrow").textContent = "A NEW ADDITION";
    $("#save-label").textContent = "Add to library";
    clearError($("#dialog-error"));
    editingId = null;
    setDraftValues("author", []);
    setDraftValues("tag", []);
    coverFile = null;
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = "";
  }

  function openAddDialog() {
    if (!canEditLibrary()) return;
    resetForm();
    bookDialog.showModal();
    bookForm.elements.title.focus();
  }

  function openEditDialog(id) {
    if (!canEditLibrary()) return;
    const book = books.find(item => item.id === id);
    if (!book) return;
    resetForm();
    editingId = id;
    bookForm.elements.title.value = book.title || "";
    setDraftValues("author", getBookAuthors(book));
    setDraftValues("tag", getBookTags(book));
    bookForm.elements.status.value = book.status || "want";
    bookForm.elements.year.value = book.year || "";
    bookForm.elements.pages.value = book.pages || "";
    bookForm.elements.isbn.value = book.isbn || "";
    bookForm.elements.notes.value = book.notes || "";
    $("#more-details").open = true;
    $("#form-title").innerHTML = "Book details<span class=\"heading-dot\">.</span>";
    $("#form-eyebrow").textContent = "YOUR COLLECTION";
    $("#save-label").textContent = "Save changes";
    $("#delete-book").hidden = false;
    if (book.cover_url) {
      $("#cover-preview").textContent = "";
      $("#cover-preview").style.backgroundImage = `url("${book.cover_url.replace(/["\\]/g, "")}")`;
      $("#cover-label").textContent = "Change cover photo";
    } else if (book.cover_data) {
      $("#cover-preview").textContent = "";
      $("#cover-preview").style.backgroundImage = `url("${book.cover_data.replace(/["\\]/g, "")}")`;
      $("#cover-label").textContent = "Change cover photo";
    } else if (book.cover_path && supabase) {
      getDisplayCoverUrl(book.cover_path).then(url => {
        if (editingId !== id || coverFile) return;
        $("#cover-preview").textContent = "";
        $("#cover-preview").style.backgroundImage = `url("${url.replace(/["\\]/g, "")}")`;
        $("#cover-label").textContent = "Change cover photo";
      }).catch(error => notify(`Could not load cover: ${error.message}`));
    }
    bookDialog.showModal();
  }

  async function optimizeCoverImage(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        typeof createImageBitmap !== "function" || file.size < 50 * 1024) return file;

    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare the cover image for optimization.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.78));
      if (!blob || blob.size >= file.size) return file;
      const name = file.name.replace(/\.[^.]+$/, "") || "book-cover";
      return new File([blob], `${name}.webp`, { type: "image/webp", lastModified: file.lastModified });
    } finally {
      bitmap.close();
    }
  }

  async function getCoverPath(file, oldPath) {
    if (!file) return oldPath || null;
    const optimizedFile = await optimizeCoverImage(file);
    if (!supabase) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read the selected cover image."));
        reader.readAsDataURL(optimizedFile);
      });
    }
    const extension = (optimizedFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${currentUser.id}/${localId()}.${extension}`;
    const { error } = await supabase.storage.from("book-covers").upload(path, optimizedFile, {
      contentType: optimizedFile.type || "image/jpeg",
      upsert: false
    });
    if (error) throw error;
    return path;
  }

  async function saveBook(event) {
    event.preventDefault();
    if (!canEditLibrary()) {
      showError($("#dialog-error"), new Error("Sign in as the library owner to edit books."));
      return;
    }
    const submit = bookForm.querySelector('[type="submit"]');
    submit.disabled = true;
    clearError($("#dialog-error"));
    const previous = books.find(book => book.id === editingId);
    try {
      const formData = new FormData(bookForm);
      const authors = uniqueNames(draftAuthors);
      const tags = uniqueNames(draftTags);
      const record = {
        title: String(formData.get("title")).trim(),
        author: authors[0] || "",
        authors,
        tags,
        status: formData.get("status") || "want",
        year: formData.get("year") ? Number(formData.get("year")) : null,
        pages: formData.get("pages") ? Number(formData.get("pages")) : null,
        isbn: String(formData.get("isbn") || "").trim() || null,
        notes: String(formData.get("notes") || "").trim() || null
      };
      if (!record.title || !record.authors.length) throw new Error("A title and at least one author are required.");
      const cover = await getCoverPath(coverFile, previous?.cover_path || previous?.cover_data);
      if (supabase) {
        const payload = { ...record, cover_path: cover };
        let result;
        if (editingId) result = await supabase.from("books").update(payload).eq("id", editingId).select().single();
        else result = await supabase.from("books").insert(payload).select().single();
        if (result.error) throw result.error;
        const oldPath = previous?.cover_path;
        if (oldPath && cover !== oldPath) {
          const { error } = await supabase.storage.from("book-covers").remove([oldPath]);
          if (error) notify(`Book saved, but the old cover could not be removed: ${error.message}`);
        }
      } else {
        const saved = {
          ...previous,
          ...record,
          id: editingId || localId(),
          created_at: previous?.created_at || new Date().toISOString(),
          cover_data: cover,
          cover_url: cover
        };
        await localStore.save(saved);
      }
      const wasEditing = Boolean(editingId);
      bookDialog.close();
      resetForm();
      await loadBooks();
      notify(wasEditing ? "Book details saved." : "Book added to your library.");
    } catch (error) {
      showError($("#dialog-error"), error);
    } finally {
      submit.disabled = false;
    }
  }

  async function removeBook() {
    if (!canEditLibrary()) return;
    if (!editingId) return;
    const book = books.find(item => item.id === editingId);
    if (!book || !confirm(`Remove “${book.title}” from your library?`)) return;
    const button = $("#delete-book");
    button.disabled = true;
    try {
      if (supabase) {
        const { error } = await supabase.from("books").delete().eq("id", editingId);
        if (error) throw error;
        if (book.cover_path) {
          const { error: storageError } = await supabase.storage.from("book-covers").remove([book.cover_path]);
          if (storageError) notify(`Book removed, but its cover could not be removed: ${storageError.message}`);
        }
      } else {
        await localStore.remove(editingId);
      }
      bookDialog.close();
      resetForm();
      await loadBooks();
      notify("Book removed from your library.");
    } catch (error) {
      showError($("#dialog-error"), error);
    } finally {
      button.disabled = false;
    }
  }

  async function updateStatus(id, status) {
    if (!canEditLibrary()) return;
    const book = books.find(item => item.id === id);
    if (!book || !STATUS[status]) return;
    const updated = { ...book, status };
    try {
      if (supabase) {
        const { error } = await supabase.from("books").update({ status }).eq("id", id);
        if (error) throw error;
      } else {
        await localStore.save(updated);
      }
      books = books.map(item => item.id === id ? updated : item);
      render();
      refreshBookDetailsQuickControls(updated);
      notify(`Marked “${book.title}” as ${STATUS[status].toLocaleLowerCase()}.`);
    } catch (error) {
      notify(`Could not update book: ${error.message}`);
      await loadBooks();
      refreshBookDetailsQuickControls(books.find(item => item.id === id));
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const submit = authForm.querySelector('[type="submit"]');
    submit.disabled = true;
    clearError($("#auth-error"));
    try {
      const formData = new FormData(authForm);
      const { data, error } = await supabase.auth.signInWithPassword({
        email: String(formData.get("email")).trim(),
        password: String(formData.get("password"))
      });
      if (error) throw error;
      if (!data.user) throw new Error("Sign-in completed without a user session.");
      setUser(data.user);
      await loadBooks();
    } catch (error) {
      showError($("#auth-error"), error);
    } finally {
      submit.disabled = false;
    }
  }

  async function signOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setUser(null);
      await loadBooks();
    } catch (error) {
      showError($("#auth-error"), error);
    }
  }

  function init() {
    const preferredTheme = localStorage.getItem(THEME_KEY) ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = preferredTheme;
    $("#today-label").textContent = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" })
      .format(new Date()).toLocaleUpperCase();
    $("#theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
    });
    $("#add-book").addEventListener("click", openAddDialog);
    $("#empty-add").addEventListener("click", openAddDialog);
    $("#book-grid").addEventListener("click", event => {
      const edit = event.target.closest("[data-edit]");
      if (edit) openEditDialog(edit.dataset.edit);
      const card = event.target.closest(".book-card");
      if (card && !event.target.closest("button, a, input, select, textarea, [data-tag]")) {
        const cover = card.querySelector("[data-view-book]");
        if (cover) openBookDetails(cover.dataset.viewBook);
      }
    });
    document.addEventListener("click", event => {
      const editFromDetails = event.target.closest("[data-edit-from-details]");
      if (editFromDetails) {
        const id = editFromDetails.dataset.editFromDetails;
        $("#book-details-dialog").close();
        openEditDialog(id);
        return;
      }
      const details = event.target.closest("[data-view-book]");
      if (details) {
        if ($("#suggest-dialog").open) $("#suggest-dialog").close();
        openBookDetails(details.dataset.viewBook);
      }
    });
    $("#continue-reading").addEventListener("click", event => {
      if (event.currentTarget.dataset.viewBook) openBookDetails(event.currentTarget.dataset.viewBook);
    });
    $("#book-grid").addEventListener("change", event => {
      const select = event.target.closest("[data-status]");
      if (select) updateStatus(select.dataset.status, select.value);
    });
    $("#book-details-dialog").addEventListener("change", event => {
      const status = event.target.closest("[data-details-status]");
      if (status) {
        updateStatus(status.dataset.detailsStatus, status.value);
        return;
      }
      const placement = event.target.closest("[data-details-placement]");
      if (!placement) return;
      let bookshelfId = null;
      let shelfNumber = null;
      if (placement.value !== "floor") {
        const separator = placement.value.lastIndexOf(":");
        bookshelfId = placement.value.slice(0, separator);
        shelfNumber = Number(placement.value.slice(separator + 1));
      }
      saveBookshelfPlacement(placement.dataset.detailsPlacement, bookshelfId, shelfNumber)
        .then(() => notify(bookshelfId ? "Book moved to shelf." : "Book moved to the floor."))
        .catch(error => {
          refreshBookDetailsQuickControls(books.find(item => item.id === placement.dataset.detailsPlacement));
          notify(`Could not move book: ${error.message}`);
        });
    });
    document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
      activateFilter(button.dataset.filter);
    }));
    $("#authors-button").addEventListener("click", () => activateFilter("authors"));
    $("#bookshelves-button").addEventListener("click", () => activateFilter("bookshelves"));
    $("#authors-grid").addEventListener("click", event => {
      const authorCard = event.target.closest("[data-author]");
      if (authorCard) showAuthorBooks(authorCard.dataset.author);
    });
    $("#add-bookshelf").addEventListener("click", () => {
      clearError($("#bookshelf-error"));
      $("#bookshelf-dialog").showModal();
      $("#bookshelf-form").elements.name.focus();
    });
    $("#bookshelf-form").addEventListener("submit", createBookshelf);
    $("#bookshelf-list").addEventListener("click", event => {
      const addShelfButton = event.target.closest("[data-add-shelf]");
      if (addShelfButton) {
        addBookshelfShelf(addShelfButton.dataset.addShelf);
        return;
      }
      const deleteButton = event.target.closest("[data-delete-bookshelf]");
      if (deleteButton) deleteBookshelf(deleteButton.dataset.deleteBookshelf);
    });
    $("#bookshelves-view").addEventListener("dragstart", event => {
      if (!canEditLibrary()) return;
      const bookElement = event.target.closest("[data-shelf-book]");
      if (!bookElement || !event.dataTransfer) return;
      event.dataTransfer.setData("text/plain", bookElement.dataset.bookId);
      event.dataTransfer.effectAllowed = "move";
      bookElement.classList.add("is-dragging");
    });
    $("#bookshelves-view").addEventListener("dragend", event => {
      event.target.closest("[data-shelf-book]")?.classList.remove("is-dragging");
      document.querySelectorAll(".drag-over").forEach(element => element.classList.remove("drag-over"));
    });
    $("#bookshelves-view").addEventListener("dragover", event => {
      if (!canEditLibrary()) return;
      const dropZone = event.target.closest("[data-drop-kind]");
      if (!dropZone) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      dropZone.classList.add("drag-over");
    });
    $("#bookshelves-view").addEventListener("dragleave", event => {
      const dropZone = event.target.closest("[data-drop-kind]");
      if (dropZone && !dropZone.contains(event.relatedTarget)) dropZone.classList.remove("drag-over");
    });
    $("#bookshelves-view").addEventListener("drop", event => {
      if (!canEditLibrary()) return;
      const dropZone = event.target.closest("[data-drop-kind]");
      if (!dropZone) return;
      event.preventDefault();
      dropZone.classList.remove("drag-over");
      const bookId = event.dataTransfer?.getData("text/plain");
      if (!bookId) return;
      const bookshelfId = dropZone.dataset.dropKind === "shelf" ? dropZone.dataset.bookshelfId : null;
      const shelfNumber = bookshelfId ? Number(dropZone.dataset.shelfNumber) : null;
      saveBookshelfPlacement(bookId, bookshelfId, shelfNumber)
        .then(() => notify(bookshelfId ? "Book moved to shelf." : "Book moved to the floor."))
        .catch(error => notify(`Could not move book: ${error.message}`));
    });
    $("#bookshelves-view").addEventListener("pointerover", event => {
      const bookElement = event.target.closest("[data-shelf-book]");
      if (!bookElement || bookElement.contains(event.relatedTarget)) return;
      if (event.pointerType === "touch") bookTooltipPinned = true;
      clearTimeout(bookTooltipTimer);
      showBookTooltip(bookElement);
    });
    $("#bookshelves-view").addEventListener("pointerout", event => {
      const bookElement = event.target.closest("[data-shelf-book]");
      if (!bookElement || bookElement.contains(event.relatedTarget) || $("#book-tooltip").contains(event.relatedTarget)) return;
      if (bookTooltipPinned) return;
      bookTooltipTimer = setTimeout(() => { $("#book-tooltip").hidden = true; }, 180);
    });
    $("#bookshelves-view").addEventListener("click", event => {
      const bookElement = event.target.closest("[data-shelf-book]");
      if (!bookElement) return;
      bookTooltipPinned = false;
      clearTimeout(bookTooltipTimer);
      $("#book-tooltip").hidden = true;
      openBookDetails(bookElement.dataset.bookId);
    });
    $("#bookshelves-view").addEventListener("focusin", event => {
      const bookElement = event.target.closest("[data-shelf-book]");
      if (bookElement) showBookTooltip(bookElement);
    });
    $("#bookshelves-view").addEventListener("focusout", event => {
      if (event.target.closest("[data-shelf-book]") && !$("#book-tooltip").contains(event.relatedTarget)) {
        bookTooltipTimer = setTimeout(() => { $("#book-tooltip").hidden = true; }, 180);
      }
    });
    $("#book-tooltip").addEventListener("pointerenter", () => clearTimeout(bookTooltipTimer));
    $("#book-tooltip").addEventListener("pointerleave", event => {
      if (!bookTooltipPinned && !event.relatedTarget?.closest?.("[data-shelf-book]")) $("#book-tooltip").hidden = true;
    });
    document.addEventListener("pointerdown", event => {
      if ($("#book-tooltip").contains(event.target) || event.target.closest?.("[data-shelf-book]")) return;
      bookTooltipPinned = false;
      $("#book-tooltip").hidden = true;
    });
    $("#book-tooltip").addEventListener("change", event => {
      const placement = event.target.closest("[data-tooltip-placement]");
      if (!placement) return;
      let bookshelfId = null;
      let shelfNumber = null;
      if (placement.value !== "floor") {
        const separator = placement.value.lastIndexOf(":");
        bookshelfId = placement.value.slice(0, separator);
        shelfNumber = Number(placement.value.slice(separator + 1));
      }
      saveBookshelfPlacement(placement.dataset.tooltipPlacement, bookshelfId, shelfNumber)
        .then(() => {
          bookTooltipPinned = false;
          $("#book-tooltip").hidden = true;
          notify(bookshelfId ? "Book moved to shelf." : "Book moved to the floor.");
        })
        .catch(error => notify(`Could not move book: ${error.message}`));
    });
    $("#book-grid").addEventListener("click", event => {
      const tagChip = event.target.closest("[data-tag]");
      if (!tagChip) return;
      const name = tagChip.dataset.tag;
      if (!includedTags.some(tag => tag.toLocaleLowerCase() === name.toLocaleLowerCase())) includedTags.push(name);
      excludedTags = excludedTags.filter(tag => tag.toLocaleLowerCase() !== name.toLocaleLowerCase());
      activeFilter = "all";
      selectedAuthor = "";
      render();
    });
    $("#tag-filter-options").addEventListener("click", event => {
      const choice = event.target.closest("[data-tag-filter]");
      if (!choice) return;
      const name = choice.dataset.tag;
      const included = includedTags.some(tag => tag.toLocaleLowerCase() === name.toLocaleLowerCase());
      const excluded = excludedTags.some(tag => tag.toLocaleLowerCase() === name.toLocaleLowerCase());
      includedTags = includedTags.filter(tag => tag.toLocaleLowerCase() !== name.toLocaleLowerCase());
      excludedTags = excludedTags.filter(tag => tag.toLocaleLowerCase() !== name.toLocaleLowerCase());
      if (choice.dataset.tagFilter === "include" && !included) includedTags.push(name);
      if (choice.dataset.tagFilter === "exclude" && !excluded) excludedTags.push(name);
      if (activeFilter === "authors" || activeFilter === "bookshelves") activeFilter = "all";
      render();
    });
    $("#clear-tag-filters").addEventListener("click", () => {
      includedTags = [];
      excludedTags = [];
      render();
    });
    $("#tag-picker-list").addEventListener("click", event => {
      const chip = event.target.closest("[data-draft-tag]");
      if (!chip) return;
      const value = chip.dataset.draftTag;
      const existing = draftTags.findIndex(tag => tag.toLocaleLowerCase() === value.toLocaleLowerCase());
      if (existing >= 0) draftTags.splice(existing, 1);
      else draftTags.push(value);
      setDraftValues("tag", draftTags);
    });
    $("#add-author").addEventListener("click", () => addDraftValue("author"));
    $("#add-tag").addEventListener("click", () => addDraftValue("tag"));
    $("#author-input").addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        addDraftValue("author");
      }
    });
    $("#tag-input").addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        addDraftValue("tag");
      }
    });
    $("#selected-authors").addEventListener("click", event => {
      const remove = event.target.closest("[data-remove-author]");
      if (remove) removeDraftValue("author", Number(remove.dataset.removeAuthor));
    });
    $("#selected-tags").addEventListener("click", event => {
      const remove = event.target.closest("[data-remove-tag]");
      if (remove) removeDraftValue("tag", Number(remove.dataset.removeTag));
    });
    $("#search-input").addEventListener("input", event => {
      searchTerm = event.target.value;
      render();
    });
    $("#suggest-book").addEventListener("click", openSuggestionDialog);
    $("#suggest-tags").addEventListener("click", event => {
      const chip = event.target.closest("[data-suggest-tag]");
      if (!chip) return;
      const value = chip.dataset.suggestTag;
      const index = suggestionTags.findIndex(tag => tag.toLocaleLowerCase() === value.toLocaleLowerCase());
      if (index >= 0) suggestionTags.splice(index, 1);
      else suggestionTags.push(value);
      renderSuggestionTags();
    });
    $("#get-suggestion").addEventListener("click", () => {
      showSuggestion();
      $("#get-suggestion").innerHTML = `<span aria-hidden="true">✦</span> Suggest another`;
    });
    $("#suggest-dialog").addEventListener("close", () => {
      suggestedBookIds = new Set();
      $("#get-suggestion").innerHTML = `<span aria-hidden="true">✦</span> Surprise me`;
    });
    $("#sort-select").addEventListener("change", render);
    $("#view-select").addEventListener("change", event => {
      const selectedView = event.currentTarget.value;
      if (!BOOK_VIEWS.includes(selectedView)) return;
      bookView = selectedView;
      localStorage.setItem(VIEW_KEY, bookView);
      render();
    });
    document.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        $("#search-input").focus();
      }
    });
    bookForm.addEventListener("submit", saveBook);
    $("#delete-book").addEventListener("click", removeBook);
    $("#cover-input").addEventListener("change", () => {
      const file = $("#cover-input").files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showError($("#dialog-error"), new Error("Choose an image file for the cover."));
        return;
      }
      coverFile = file;
      if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
      coverPreviewUrl = URL.createObjectURL(file);
      $("#cover-preview").textContent = "";
      $("#cover-preview").style.backgroundImage = `url("${coverPreviewUrl}")`;
      $("#cover-label").textContent = file.name;
      clearError($("#dialog-error"));
    });
    document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => {
      button.closest("dialog").close();
      if (button.closest("#book-dialog")) resetForm();
    }));
    [bookDialog, authDialog, $("#bookshelf-dialog"), $("#book-details-dialog")].forEach(dialog => dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    }));
    const openAccountDialog = () => {
      if (supabase && currentUser) {
        authForm.elements.email.value = currentUser.email || "";
        authForm.elements.password.value = "";
        $("#sign-out").hidden = false;
      }
      clearError($("#auth-error"));
      authDialog.showModal();
    };
    $("#account-button").addEventListener("click", openAccountDialog);
    $("#mobile-account-button").addEventListener("click", openAccountDialog);

    if (!remoteEnabled) {
      loadBooks().catch(error => {
        showError($("#dialog-error"), error);
        notify(error.message);
      });
      return;
    }
    if (!supabase) {
      notify("Supabase client could not load. Check your internet connection or CDN access.");
      return;
    }
    $("#account-mode").textContent = "Read-only · sign in to edit";
    authForm.addEventListener("submit", signIn);
    $("#sign-out").addEventListener("click", signOut);
    supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      setUser(data.session?.user || null);
      loadBooks().catch(loadError => notify(`Could not load public library: ${loadError.message}`));
    }).catch(error => {
      notify(`Could not check sign-in status: ${error.message}`);
      loadBooks().catch(loadError => notify(`Could not load public library: ${loadError.message}`));
    });
  }

  init();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .catch(error => console.error("Service worker registration failed:", error)));
  }
})();
