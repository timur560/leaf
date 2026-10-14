# Leaf — your home library

Leaf is a responsive, installable single-page app for keeping a personal book catalog. It uses plain HTML, CSS, and JavaScript and can be hosted as a static site on GitHub Pages.

## What it can do

- Add a book quickly with its title and one or more authors.
- Reuse author suggestions, browse all authors, and open an author's books.
- Add multiple tags to a book, create or reuse tag suggestions, and filter by one or more tags (a book must have every selected tag).
- Add a cover photo, reading status, publication year, page count, ISBN, and notes now or later.
- Open a read-only details panel from a public book's cover to view its full metadata.
- Search and sort books; filter by reading status.
- Switch the collection between compact tiles, small tiles, large tiles, a table, and a list; the selected view is remembered on this device.
- Build named bookshelves with two or more shelves, assign books by drag-and-drop or from a book's popover, and gather unshelved books in a floor pile.
- See a loading indicator while the collection is being fetched.
- Change a book's status directly from its card, or edit/remove it.
- Switch between light and dark themes.
- Install it as a PWA on supported desktop and mobile browsers.
- Use Supabase Auth, Postgres, and Supabase Storage when configured.
- Let anyone browse the Supabase-backed catalog and covers without signing in; only the signed-in owner can change books or shelves.
- Load cover images only as they approach the visible area. Existing covers use Supabase image transformations when enabled for the project, with automatic original-image fallback. New large JPEG, PNG, and WebP covers are resized and converted to WebP when that reduces file size.

Without Supabase credentials, the app works in a local-only mode and saves its catalog in that browser's local storage. This is useful for trying the interface, but it is not a backed-up database and does not sync between devices.

**Public visibility:** when using Supabase, all book fields (including notes, reading status, ISBN, and tags), bookshelves, and covers are publicly readable by anyone. Sign-in is required only for changes. Do not store anything in the catalog that you do not want to publish.

## Connect Supabase

### 1. Create the Supabase project and database

Create a project at [supabase.com](https://supabase.com/). In the project's SQL Editor, run:

```sql
create table public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  author text not null check (char_length(author) between 1 and 140),
  authors text[] not null default '{}',
  tags text[] not null default '{}',
  status text not null default 'want' check (status in ('want', 'reading', 'read')),
  year integer check (year is null or year between 0 and 2200),
  pages integer check (pages is null or pages between 1 and 100000),
  isbn text,
  notes text check (notes is null or char_length(notes) <= 2000),
  cover_path text,
  bookshelf_id uuid,
  bookshelf_shelf integer check (bookshelf_shelf is null or bookshelf_shelf >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bookshelves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  shelf_count integer not null default 2 check (shelf_count >= 2),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

alter table public.books
  add constraint books_bookshelf_owner_fk
    foreign key (bookshelf_id, user_id) references public.bookshelves(id, user_id),
  add constraint books_bookshelf_placement_check
    check ((bookshelf_id is null and bookshelf_shelf is null) or
           (bookshelf_id is not null and bookshelf_shelf is not null and bookshelf_shelf >= 1));

alter table public.books enable row level security;
alter table public.bookshelves enable row level security;
grant select on public.books, public.bookshelves to anon, authenticated;

create policy "Public can read books"
  on public.books for select to anon, authenticated
  using (true);

create policy "Add books to your own library"
  on public.books for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Update your own books"
  on public.books for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Delete your own books"
  on public.books for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "Public can read bookshelves"
  on public.bookshelves for select to anon, authenticated
  using (true);

create policy "Add bookshelves to your own library"
  on public.bookshelves for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Update your own bookshelves"
  on public.bookshelves for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Delete your own bookshelves"
  on public.bookshelves for delete to authenticated
  using ((select auth.uid()) = user_id);
```

If the `books` table already exists, run this migration once in the Supabase SQL Editor before using the updated app. It keeps the old `author` column for compatibility and copies each existing author into the new array:

```sql
alter table public.books
  add column if not exists authors text[] not null default '{}',
  add column if not exists tags text[] not null default '{}';

update public.books
set authors = array[author]
where cardinality(authors) = 0
  and author is not null
  and btrim(author) <> '';

create table public.bookshelves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  shelf_count integer not null default 2 check (shelf_count >= 2),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

alter table public.books
  add column if not exists bookshelf_id uuid,
  add column if not exists bookshelf_shelf integer;

alter table public.books
  add constraint books_bookshelf_owner_fk
    foreign key (bookshelf_id, user_id) references public.bookshelves(id, user_id),
  add constraint books_bookshelf_placement_check
    check ((bookshelf_id is null and bookshelf_shelf is null) or
           (bookshelf_id is not null and bookshelf_shelf is not null and bookshelf_shelf >= 1));

alter table public.bookshelves enable row level security;
grant select on public.books, public.bookshelves to anon, authenticated;

create policy "Read your own bookshelves"
  on public.bookshelves for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Add bookshelves to your own library"
  on public.bookshelves for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Update your own bookshelves"
  on public.bookshelves for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Delete your own bookshelves"
  on public.bookshelves for delete to authenticated
  using ((select auth.uid()) = user_id);
```

Row Level Security is essential: it allows anonymous reads, while the insert, update, and delete policies still allow only the authenticated owner to make changes. Never put a `service_role` key in this app.

### 2. Set up cover storage

In **Storage**, create a bucket named `book-covers` and leave **Public bucket** turned off. Then run the following in the SQL Editor. The app stores each user's files in a folder named with their auth user ID and uses short-lived signed URLs to display them. The read policy allows any visitor to request signed URLs for covers; upload, update, and delete remain limited to the authenticated owner.

```sql
create policy "Public can read book covers"
  on storage.objects for select to anon, authenticated
  using (
    bucket_id = 'book-covers'
  );
grant select on storage.objects to anon, authenticated;

create policy "Upload your own book covers"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Update your own book covers"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Delete your own book covers"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'book-covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
```

For an existing database, run this additional read-only policy once to enable anonymous catalog and cover access. Keep the existing owner-only insert, update, and delete policies unchanged:

```sql
create policy "Public can read books"
  on public.books for select to anon, authenticated
  using (true);

create policy "Public can read bookshelves"
  on public.bookshelves for select to anon, authenticated
  using (true);
grant select on public.books, public.bookshelves to anon, authenticated;

create policy "Public can read book covers"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'book-covers');
grant select on storage.objects to anon, authenticated;
```

### 3. Create your account and configure the app

For a single-user library, turn off public signups in **Authentication → Settings / Providers → Email** (the exact menu label may change). Create your own user from **Authentication → Users → Add user** and choose a strong password. The app intentionally has a sign-in form but no public sign-up flow.

Find the project's **Project URL** and **anon/publishable key** in its API settings. Put them in `config.js`:

```js
window.LEAF_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_ID.supabase.co",
  supabaseAnonKey: "YOUR_ANON_OR_PUBLISHABLE_KEY"
};
```

This key is designed to be used in browser code and is not a secret; database and storage RLS policies enforce access. Do not use the `service_role` key. In Supabase **Authentication → URL Configuration**, set the Site URL to your GitHub Pages URL and add that URL to the allowed redirect URLs.

### 4. Publish with GitHub Pages

Commit/push the app files to your repository. In **Settings → Pages**, choose the branch and folder containing `index.html` (usually `main` and `/(root)`) and save. Wait for the Pages URL, then add that exact URL to Supabase's Site URL/redirect URL settings above.

GitHub Pages serves the HTML, CSS, and JavaScript publicly; it cannot password-protect the site itself. The catalog and cover images are intentionally public and read-only. Only the signed-in owner can add, edit, move, or remove books and bookshelves; Supabase RLS and Storage policies enforce this even if someone bypasses the app UI. Never put a `service_role` key in the repository.

## Install and offline notes

Open the HTTPS GitHub Pages URL on your phone and choose **Add to Home Screen** (iOS Safari) or **Install app** (supported Android browsers). The service worker caches the app shell. Supabase sign-in, synced catalog updates, and cover loading require a network connection; local-only mode stores data only in that browser and its images can use substantial device storage.
