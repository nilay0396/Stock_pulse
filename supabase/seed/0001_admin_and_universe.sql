-- Curated 51-stock universe, ported verbatim from backend/stock_universe.py::UNIVERSE.
-- yf_symbol = symbol with '&' -> '%26', suffixed '.NS' (to_yf_symbol()).
-- Safe to re-run: upserts by symbol.

insert into stock_universe (symbol, yf_symbol, name, sector, industry, market_cap_tier) values
  ('HDFCBANK', 'HDFCBANK.NS', 'HDFC Bank', 'Banking', 'Private Bank', 'large'),
  ('ICICIBANK', 'ICICIBANK.NS', 'ICICI Bank', 'Banking', 'Private Bank', 'large'),
  ('SBIN', 'SBIN.NS', 'State Bank of India', 'Banking', 'Public Bank', 'large'),
  ('KOTAKBANK', 'KOTAKBANK.NS', 'Kotak Mahindra Bank', 'Banking', 'Private Bank', 'large'),
  ('AXISBANK', 'AXISBANK.NS', 'Axis Bank', 'Banking', 'Private Bank', 'large'),
  ('BAJFINANCE', 'BAJFINANCE.NS', 'Bajaj Finance', 'Financial Services', 'NBFC', 'large'),
  ('BAJAJFINSV', 'BAJAJFINSV.NS', 'Bajaj Finserv', 'Financial Services', 'Holding', 'large'),
  ('HDFCLIFE', 'HDFCLIFE.NS', 'HDFC Life Insurance', 'Financial Services', 'Insurance', 'large'),
  ('SBILIFE', 'SBILIFE.NS', 'SBI Life Insurance', 'Financial Services', 'Insurance', 'large'),
  ('TCS', 'TCS.NS', 'Tata Consultancy Services', 'IT', 'IT Services', 'large'),
  ('INFY', 'INFY.NS', 'Infosys', 'IT', 'IT Services', 'large'),
  ('WIPRO', 'WIPRO.NS', 'Wipro', 'IT', 'IT Services', 'large'),
  ('HCLTECH', 'HCLTECH.NS', 'HCL Technologies', 'IT', 'IT Services', 'large'),
  ('TECHM', 'TECHM.NS', 'Tech Mahindra', 'IT', 'IT Services', 'large'),
  ('LTIM', 'LTIM.NS', 'LTIMindtree', 'IT', 'IT Services', 'large'),
  ('RELIANCE', 'RELIANCE.NS', 'Reliance Industries', 'Energy', 'Conglomerate', 'large'),
  ('ONGC', 'ONGC.NS', 'Oil & Natural Gas Corp', 'Energy', 'Oil & Gas', 'large'),
  ('IOC', 'IOC.NS', 'Indian Oil Corp', 'Energy', 'Oil Marketing', 'large'),
  ('BPCL', 'BPCL.NS', 'Bharat Petroleum', 'Energy', 'Oil Marketing', 'large'),
  ('GAIL', 'GAIL.NS', 'GAIL India', 'Energy', 'Gas', 'large'),
  ('MARUTI', 'MARUTI.NS', 'Maruti Suzuki', 'Auto', 'Passenger Vehicles', 'large'),
  ('M&M', 'M%26M.NS', 'Mahindra & Mahindra', 'Auto', 'Auto', 'large'),
  ('BAJAJ-AUTO', 'BAJAJ-AUTO.NS', 'Bajaj Auto', 'Auto', 'Two Wheelers', 'large'),
  ('HEROMOTOCO', 'HEROMOTOCO.NS', 'Hero MotoCorp', 'Auto', 'Two Wheelers', 'large'),
  ('EICHERMOT', 'EICHERMOT.NS', 'Eicher Motors', 'Auto', 'Two Wheelers', 'large'),
  ('HINDUNILVR', 'HINDUNILVR.NS', 'Hindustan Unilever', 'FMCG', 'Personal & HH Care', 'large'),
  ('ITC', 'ITC.NS', 'ITC', 'FMCG', 'Diversified', 'large'),
  ('NESTLEIND', 'NESTLEIND.NS', 'Nestle India', 'FMCG', 'Packaged Foods', 'large'),
  ('BRITANNIA', 'BRITANNIA.NS', 'Britannia Industries', 'FMCG', 'Packaged Foods', 'large'),
  ('DABUR', 'DABUR.NS', 'Dabur India', 'FMCG', 'Personal Care', 'large'),
  ('TITAN', 'TITAN.NS', 'Titan Company', 'Consumer', 'Jewellery & Watches', 'large'),
  ('SUNPHARMA', 'SUNPHARMA.NS', 'Sun Pharmaceutical', 'Pharma', 'Pharma', 'large'),
  ('DRREDDY', 'DRREDDY.NS', 'Dr. Reddy''s Labs', 'Pharma', 'Pharma', 'large'),
  ('CIPLA', 'CIPLA.NS', 'Cipla', 'Pharma', 'Pharma', 'large'),
  ('DIVISLAB', 'DIVISLAB.NS', 'Divi''s Laboratories', 'Pharma', 'APIs', 'large'),
  ('APOLLOHOSP', 'APOLLOHOSP.NS', 'Apollo Hospitals', 'Healthcare', 'Hospitals', 'large'),
  ('TATASTEEL', 'TATASTEEL.NS', 'Tata Steel', 'Metals', 'Steel', 'large'),
  ('JSWSTEEL', 'JSWSTEEL.NS', 'JSW Steel', 'Metals', 'Steel', 'large'),
  ('HINDALCO', 'HINDALCO.NS', 'Hindalco Industries', 'Metals', 'Aluminum & Copper', 'large'),
  ('COALINDIA', 'COALINDIA.NS', 'Coal India', 'Metals', 'Coal', 'large'),
  ('VEDL', 'VEDL.NS', 'Vedanta', 'Metals', 'Diversified', 'large'),
  ('ULTRACEMCO', 'ULTRACEMCO.NS', 'UltraTech Cement', 'Cement', 'Cement', 'large'),
  ('GRASIM', 'GRASIM.NS', 'Grasim Industries', 'Cement', 'Diversified', 'large'),
  ('LT', 'LT.NS', 'Larsen & Toubro', 'Infrastructure', 'EPC', 'large'),
  ('BHARTIARTL', 'BHARTIARTL.NS', 'Bharti Airtel', 'Telecom', 'Telecom', 'large'),
  ('NTPC', 'NTPC.NS', 'NTPC', 'Power', 'Power Generation', 'large'),
  ('POWERGRID', 'POWERGRID.NS', 'Power Grid Corp', 'Power', 'Transmission', 'large'),
  ('ADANIPORTS', 'ADANIPORTS.NS', 'Adani Ports & SEZ', 'Infrastructure', 'Ports', 'large'),
  ('ADANIENT', 'ADANIENT.NS', 'Adani Enterprises', 'Infrastructure', 'Diversified', 'large'),
  ('ASIANPAINT', 'ASIANPAINT.NS', 'Asian Paints', 'Chemicals', 'Paints', 'large'),
  ('PIDILITIND', 'PIDILITIND.NS', 'Pidilite Industries', 'Chemicals', 'Adhesives', 'large')
on conflict (symbol) do update set
  yf_symbol = excluded.yf_symbol,
  name = excluded.name,
  sector = excluded.sector,
  industry = excluded.industry,
  market_cap_tier = excluded.market_cap_tier;

-- Admin user seed.
--
-- IMPORTANT: the value below is NOT your password — it must be a bcrypt HASH
-- of it. Storing the plaintext password here would break login (bcrypt can't
-- compare plaintext against plaintext as if it were a hash) and is a real
-- security issue. Generate the hash first, in netlify/functions/:
--   node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD_HERE', 10))"
-- It will look like: $2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN
-- Paste THAT string below, not your password.
--
-- Only inserts if no admin exists yet (mirrors seed_admin()'s "seed once" behavior).
insert into users (email, name, role, password_hash)
select 'admin@marketpulse.in', 'Administrator', 'admin', '$2a$10$REPLACE_WITH_A_REAL_BCRYPT_HASH_NOT_YOUR_PASSWORD'
where not exists (select 1 from users where role = 'admin');
