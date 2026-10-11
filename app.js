(() => {
  "use strict";

  const STATUS = {
    want: "Want to read",
    reading: "Currently reading",
    read: "Finished"
  };
  const STORAGE_KEY = "leaf-library-books-v1";
  const THEME_KEY = "leaf-library-theme";
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
  let searchTerm = "";
  let editingId = null;
  let coverFile = null;
  let coverPreviewUrl = "";
  let currentUser = null;
  let toastTimer;

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

  function getFilteredBooks() {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
    return books.filter(book => {
      const matchesFilter = activeFilter === "all" || book.status === activeFilter;
      const matchesSearch = !normalizedSearch || [book.title, book.author, book.isbn, book.notes]
        .some(value => String(value || "").toLocaleLowerCase().includes(normalizedSearch));
      return matchesFilter && matchesSearch;
    }).sort((a, b) => {
      switch ($("#sort-select").value) {
        case "title": return a.title.localeCompare(b.title);
        case "author": return a.author.localeCompare(b.author);
        case "year": return (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title);
        default: return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      }
    });
  }

  function render() {
    const filtered = getFilteredBooks();
    grid.innerHTML = filtered.map(book => {
      const initial = safeText((book.title || "?").trim().charAt(0).toLocaleUpperCase());
      const gradient = ["sage", "rose", "ochre", "blue"][Array.from(book.title || "").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4];
      const image = book.cover_url
        ? `<img src="${safeText(book.cover_url)}" alt="" loading="lazy">`
        : `<div class="cover-placeholder ${gradient}"><span class="cover-initial">${initial}</span><span class="cover-spine"></span></div>`;
      const detailLine = [book.year, book.pages ? `${book.pages} pages` : ""].filter(Boolean).join(" · ");
      return `<article class="book-card">
        <button class="book-cover" type="button" data-edit="${safeText(book.id)}" aria-label="Edit ${safeText(book.title)}">
          ${image}<span class="status-badge status-${safeText(book.status || "want")}">${safeText(STATUS[book.status] || STATUS.want)}</span>
          <span class="cover-edit" aria-hidden="true">↗</span>
        </button>
        <div class="book-card-body">
          <h3 title="${safeText(book.title)}">${safeText(book.title)}</h3>
          <p class="book-author">${safeText(book.author)}</p>
          ${detailLine ? `<p class="book-meta">${safeText(detailLine)}</p>` : `<p class="book-meta muted-meta">Add book details ↗</p>`}
          <label class="status-control"><span class="sr-only">Reading status for ${safeText(book.title)}</span>
            <select data-status="${safeText(book.id)}" aria-label="Reading status for ${safeText(book.title)}">
              ${Object.entries(STATUS).map(([key, label]) => `<option value="${key}" ${book.status === key ? "selected" : ""}>${safeText(label)}</option>`).join("")}
            </select><span aria-hidden="true">⌄</span>
          </label>
        </div>
      </article>`;
    }).join("");

    const count = books.length;
    $("#count-all").textContent = count;
    $("#count-reading").textContent = books.filter(book => book.status === "reading").length;
    $("#count-read").textContent = books.filter(book => book.status === "read").length;
    $("#count-want").textContent = books.filter(book => book.status === "want").length;
    $("#stat-total").textContent = count;
    $("#stat-read").textContent = books.filter(book => book.status === "read").length;
    $("#results-label").textContent = `${filtered.length} ${filtered.length === 1 ? "book" : "books"}`;
    $("#section-title").textContent = activeFilter === "all" ? "Your collection" : STATUS[activeFilter] === "Finished" ? "Finished books" : STATUS[activeFilter];
    $("#empty-state").hidden = filtered.length > 0;
    grid.hidden = filtered.length === 0;
    const noMatch = count > 0 && filtered.length === 0;
    $("#empty-title").textContent = noMatch ? "No books found." : "Your shelves are waiting.";
    $("#empty-copy").textContent = noMatch
      ? "Try another search or choose a different shelf."
      : "Start with a title and author. You can fill in the rest whenever you like.";
    $("#empty-add").hidden = noMatch || activeFilter !== "all";
    const currentBook = books.find(book => book.status === "reading");
    $("#reading-card").hidden = !currentBook || activeFilter !== "all";
    if (currentBook) {
      $("#reading-title").textContent = currentBook.title;
      $("#reading-author").textContent = `by ${currentBook.author}`;
      $("#continue-reading").dataset.edit = currentBook.id;
    }
  }

  async function loadBooks() {
    if (!supabase) {
      books = await localStore.load();
      $("#sync-status").textContent = "SAVED ON THIS DEVICE";
      $("#account-mode").textContent = "This device only";
      render();
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
    render();
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
    bookForm.elements.author.value = book.author || "";
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
      const cover = await getCoverPath(coverFile, previous?.cover_path || previous?.cover_data);
      const record = {
        title: String(formData.get("title")).trim(),
        author: String(formData.get("author")).trim(),
        status: formData.get("status") || "want",
        year: formData.get("year") ? Number(formData.get("year")) : null,
        pages: formData.get("pages") ? Number(formData.get("pages")) : null,
        isbn: String(formData.get("isbn") || "").trim() || null,
        notes: String(formData.get("notes") || "").trim() || null
      };
      if (!record.title || !record.author) throw new Error("A title and author are required.");
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
      activeFilter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach(item => item.classList.toggle("active", item === button));
      $("#view-title").textContent = activeFilter === "all" ? "All books" : STATUS[activeFilter];
      render();
    }));
    $("#search-input").addEventListener("input", event => {
      searchTerm = event.target.value;
      render();
    });
    $("#sort-select").addEventListener("change", render);
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
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js")
      .catch(error => console.error("Service worker registration failed:", error)));
  }
})();
