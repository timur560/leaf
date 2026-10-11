(() => {
  "use strict";

  const STATUS = {
    want: "Want to read",
    reading: "Currently reading",
    read: "Finished"
  };
  const STORAGE_KEY = "leaf-library-books-v1";
  const THEME_KEY = "leaf-library-theme";
  const VIEW_KEY = "leaf-library-view";
  const BOOK_VIEWS = ["small", "large", "table", "list"];
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
  let activeFilter = "all";
  let selectedAuthor = "";
  let selectedTags = [];
  let draftAuthors = [];
  let draftTags = [];
  let searchTerm = "";
  let editingId = null;
  let coverFile = null;
  let coverPreviewUrl = "";
  let currentUser = null;
  let toastTimer;
  let isLoading = false;
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
        activeFilter === "author-books" || book.status === activeFilter;
      const matchesAuthor = activeFilter !== "author-books" ||
        getBookAuthors(book).some(author => author.toLocaleLowerCase() === selectedAuthor.toLocaleLowerCase());
      const bookTags = getBookTags(book).map(tag => tag.toLocaleLowerCase());
      const matchesTags = selectedTags.every(tag => bookTags.includes(tag.toLocaleLowerCase()));
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

  function render() {
    const filtered = getFilteredBooks();
    const authors = getAuthors();
    const tags = getTags();
    const authorDirectory = activeFilter === "authors";
    const authorBooks = activeFilter === "author-books";
    $("#author-suggestions").innerHTML = authors
      .map(author => `<option value="${safeText(author.name)}"></option>`).join("");
    $("#tag-suggestions").innerHTML = tags
      .map(tag => `<option value="${safeText(tag.name)}"></option>`).join("");
    $("#tag-filter-options").innerHTML = tags.length ? tags.map(tag => {
      const checked = selectedTags.some(selected => selected.toLocaleLowerCase() === tag.name.toLocaleLowerCase());
      return `<label class="tag-filter-option"><input type="checkbox" value="${safeText(tag.name)}" ${checked ? "checked" : ""}><span>${safeText(tag.name)}</span><small>${tag.count}</small></label>`;
    }).join("") : `<p class="no-tags">Add tags to books to filter your collection.</p>`;
    $("#tag-filter-count").textContent = selectedTags.length ? `(${selectedTags.length})` : "";
    $("#view-select").value = bookView;
    $("#view-select").closest(".view-select").hidden = authorDirectory;
    $("#tag-filter-wrap").hidden = authorDirectory;
    $("#count-authors").textContent = authors.length;
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
    grid.dataset.view = bookView;
    grid.hidden = isLoading || authorDirectory || filtered.length === 0;
    const bookMarkup = filtered.map(book => {
      const initial = safeText((book.title || "?").trim().charAt(0).toLocaleUpperCase());
      const gradient = ["sage", "rose", "ochre", "blue"][Array.from(book.title || "").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4];
      const image = book.cover_url
        ? `<img src="${safeText(book.cover_url)}" alt="" loading="lazy">`
        : `<div class="cover-placeholder ${gradient}"><span class="cover-initial">${initial}</span><span class="cover-spine"></span></div>`;
      const detailLine = [book.year, book.pages ? `${book.pages} pages` : ""].filter(Boolean).join(" · ");
      const authorsLabel = getBookAuthors(book).join(", ");
      const bookTags = getBookTags(book);
      const cover = `<button class="book-cover" type="button" data-edit="${safeText(book.id)}" aria-label="Edit ${safeText(book.title)}">
        ${image}<span class="status-badge status-${safeText(book.status || "want")}">${safeText(STATUS[book.status] || STATUS.want)}</span>
        <span class="cover-edit" aria-hidden="true">↗</span>
      </button>`;
      if (bookView === "table") {
        return `<tr>
          <td><button class="table-book-title" type="button" data-edit="${safeText(book.id)}">${safeText(book.title)}</button></td>
          <td>${safeText(authorsLabel)}</td>
          <td>${safeText(book.year || "—")}</td>
          <td>${safeText(book.pages || "—")}</td>
          <td>${renderBookTags(bookTags)}</td>
          <td>${renderStatusControl(book)}</td>
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
          <div class="list-book-status">${renderStatusControl(book)}</div>
        </article>`;
      }
      return `<article class="book-card">
        ${cover}
        <div class="book-card-body">
          <h3 title="${safeText(book.title)}">${safeText(book.title)}</h3>
          <p class="book-author" title="${safeText(authorsLabel)}">${safeText(authorsLabel)}</p>
          ${detailLine ? `<p class="book-meta">${safeText(detailLine)}</p>` : `<p class="book-meta muted-meta">Add book details ↗</p>`}
          ${renderBookTags(bookTags)}
          ${renderStatusControl(book)}
        </div>
      </article>`;
    }).join("");
    grid.innerHTML = bookView === "table"
      ? `<div class="book-table-wrap"><table class="book-table">
          <thead><tr><th scope="col">Title</th><th scope="col">Authors</th><th scope="col">Year</th><th scope="col">Pages</th><th scope="col">Tags</th><th scope="col">Status</th></tr></thead>
          <tbody>${bookMarkup}</tbody>
        </table></div>`
      : bookMarkup;

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
      activeFilter === "all" ? "Your collection" : STATUS[activeFilter] === "Finished" ? "Finished books" : STATUS[activeFilter];
    $("#view-title").textContent = authorDirectory ? "Authors" : authorBooks ? selectedAuthor :
      activeFilter === "all" ? "All books" : STATUS[activeFilter];
    const noMatch = authorDirectory ? visibleAuthors.length === 0 : filtered.length === 0;
    $("#empty-state").hidden = isLoading || !noMatch;
    $("#empty-title").textContent = authorDirectory
      ? (authors.length && searchTerm ? "No authors found." : "No authors yet.")
      : count > 0 ? "No books found." : "Your shelves are waiting.";
    $("#empty-copy").textContent = authorDirectory
      ? (authors.length && searchTerm ? "Try another search to find an author." : "Authors will appear here as you add books to your library.")
      : count > 0
        ? "Try another search, change the tag filters, or choose a different shelf."
        : "Start with a title and author. You can fill in the rest whenever you like.";
    $("#empty-add").hidden = authorDirectory || count > 0 || activeFilter !== "all";
    $("#sort-select").closest(".sort-select").hidden = authorDirectory;
    const currentBook = books.find(book => book.status === "reading");
    $("#reading-card").hidden = !currentBook || activeFilter !== "all";
    if (currentBook) {
      $("#reading-title").textContent = currentBook.title;
      $("#reading-author").textContent = `by ${getBookAuthors(currentBook).join(", ")}`;
      $("#continue-reading").dataset.edit = currentBook.id;
    }
    document.querySelectorAll("[data-filter]").forEach(button => {
      button.classList.toggle("active", button.dataset.filter === activeFilter ||
        (activeFilter === "author-books" && button.dataset.filter === "authors"));
    });
  }

  function activateFilter(filter) {
    activeFilter = filter;
    selectedAuthor = "";
    if (filter === "authors") selectedTags = [];
    render();
  }

  function showAuthorBooks(name) {
    selectedAuthor = name;
    activeFilter = "author-books";
    searchTerm = "";
    $("#search-input").value = "";
    render();
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
  }

  function removeDraftValue(kind, index) {
    const values = kind === "author" ? draftAuthors : draftTags;
    values.splice(index, 1);
    setDraftValues(kind, values);
  }

  async function loadBooks() {
    isLoading = true;
    render();
    try {
      if (!supabase) {
        books = await localStore.load();
        $("#sync-status").textContent = "SAVED ON THIS DEVICE";
        $("#account-mode").textContent = "This device only";
        return;
      }
      const { data, error } = await supabase.from("books").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      books = await Promise.all((data || []).map(async book => {
        if (!book.cover_path) return book;
        const { data: signed, error: signedError } = await supabase.storage.from("book-covers")
          .createSignedUrl(book.cover_path, 3600);
        if (signedError) {
          notify(`Could not load cover for “${book.title}”: ${signedError.message}`);
          return book;
        }
        return { ...book, cover_url: signed.signedUrl };
      }));
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
    $("#account-mode").textContent = user ? "Private collection" : "Sign in to your library";
    if (!user) {
      books = [];
      render();
      if (supabase && !authDialog.open) authDialog.showModal();
    } else if (authDialog.open) authDialog.close();
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
    resetForm();
    bookDialog.showModal();
    bookForm.elements.title.focus();
  }

  function openEditDialog(id) {
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
    }
    bookDialog.showModal();
  }

  async function getCoverPath(file, oldPath) {
    if (!file) return oldPath || null;
    if (!supabase) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read the selected cover image."));
        reader.readAsDataURL(file);
      });
    }
    const extension = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${currentUser.id}/${localId()}.${extension}`;
    const { error } = await supabase.storage.from("book-covers").upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: false
    });
    if (error) throw error;
    return path;
  }

  async function saveBook(event) {
    event.preventDefault();
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
      notify(`Marked “${book.title}” as ${STATUS[status].toLocaleLowerCase()}.`);
    } catch (error) {
      notify(`Could not update book: ${error.message}`);
      await loadBooks();
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
    });
    $("#continue-reading").addEventListener("click", event => {
      if (event.currentTarget.dataset.edit) openEditDialog(event.currentTarget.dataset.edit);
    });
    $("#book-grid").addEventListener("change", event => {
      const select = event.target.closest("[data-status]");
      if (select) updateStatus(select.dataset.status, select.value);
    });
    document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => {
      activateFilter(button.dataset.filter);
    }));
    $("#authors-button").addEventListener("click", () => activateFilter("authors"));
    $("#authors-grid").addEventListener("click", event => {
      const authorCard = event.target.closest("[data-author]");
      if (authorCard) showAuthorBooks(authorCard.dataset.author);
    });
    $("#book-grid").addEventListener("click", event => {
      const tagChip = event.target.closest("[data-tag]");
      if (!tagChip) return;
      const name = tagChip.dataset.tag;
      if (!selectedTags.some(tag => tag.toLocaleLowerCase() === name.toLocaleLowerCase())) selectedTags.push(name);
      activeFilter = "all";
      selectedAuthor = "";
      render();
    });
    $("#tag-filter-toggle").addEventListener("click", () => {
      const panel = $("#tag-filter-panel");
      panel.hidden = !panel.hidden;
      $("#tag-filter-toggle").setAttribute("aria-expanded", String(!panel.hidden));
    });
    $("#tag-filter-options").addEventListener("change", event => {
      const checkbox = event.target.closest('input[type="checkbox"]');
      if (!checkbox) return;
      selectedTags = selectedTags.filter(tag => tag.toLocaleLowerCase() !== checkbox.value.toLocaleLowerCase());
      if (checkbox.checked) selectedTags.push(checkbox.value);
      if (activeFilter === "authors") activeFilter = "all";
      render();
      $("#tag-filter-panel").hidden = false;
      $("#tag-filter-toggle").setAttribute("aria-expanded", "true");
    });
    $("#clear-tag-filters").addEventListener("click", () => {
      selectedTags = [];
      render();
      $("#tag-filter-panel").hidden = false;
      $("#tag-filter-toggle").setAttribute("aria-expanded", "true");
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
    [bookDialog, authDialog].forEach(dialog => dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    }));
    $("#account-button").addEventListener("click", () => {
      if (supabase && currentUser) {
        authForm.elements.email.value = currentUser.email || "";
        authForm.elements.password.value = "";
        $("#sign-out").hidden = false;
      }
      clearError($("#auth-error"));
      authDialog.showModal();
    });

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
    $("#account-mode").textContent = "Sign in required";
    authForm.addEventListener("submit", signIn);
    $("#sign-out").addEventListener("click", signOut);
    supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      if (session?.user) {
        window.setTimeout(() => {
          loadBooks().catch(error => notify(`Could not load library: ${error.message}`));
        }, 0);
      }
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      setUser(data.session?.user || null);
      if (data.session?.user) return loadBooks();
    }).catch(error => {
      showError($("#auth-error"), error);
      if (!authDialog.open) authDialog.showModal();
    });
  }

  init();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .catch(error => console.error("Service worker registration failed:", error)));
  }
})();
