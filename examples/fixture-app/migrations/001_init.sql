create table users (
  id serial primary key,
  email text not null unique,
  name text not null,
  password text not null
);

create table sessions (
  id text primary key,
  user_id integer not null references users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table items (
  id serial primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value text not null
);
