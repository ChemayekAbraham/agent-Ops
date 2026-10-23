-- Product copy for the agent's smartphone product page.
--
-- * description: a short paragraph about the model (shown on the product page).
-- * highlights: key features as short lines (shown as a checklist).
-- Both are editable by Agent Ops in the phone catalog. Seeded below for the 25 models in the
-- catalog on 2026-10-23 from the manufacturers' published specs; a row is only filled while its
-- description is still empty, so re-running never overwrites Agent Ops edits.

ALTER TABLE public.smartphone_catalog ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.smartphone_catalog ADD COLUMN IF NOT EXISTS highlights text[];

-- Samsung A06
UPDATE public.smartphone_catalog SET description = 'The Galaxy A06 is a dependable everyday Android phone with a big 6.7-inch screen and a 5,000 mAh battery that comfortably lasts a full day of field calls, WhatsApp and mobile money. Its 50 MP main camera takes clear photos of houses, receipts and documents.', highlights = ARRAY['6.7-inch HD+ display', '5,000 mAh battery with 25W charging', '50 MP main camera + 2 MP depth', 'MediaTek Helio G85, 4 GB RAM', '8 MP selfie camera']::text[]
  WHERE id = 'd526b0d4-90d1-46b1-bac3-7dd1122fd57a' AND description IS NULL;

-- Samsung A07
UPDATE public.smartphone_catalog SET description = 'The Galaxy A07 pairs a smooth 6.7-inch 90Hz screen with a 5,000 mAh battery built for long days on the road. A faster Helio G99 chip, IP54 dust and splash protection and up to six years of Android and security updates keep it reliable for years.', highlights = ARRAY['6.7-inch HD+ display, 90Hz', '5,000 mAh battery', '50 MP main camera + 2 MP depth', 'MediaTek Helio G99', 'IP54 dust & splash resistance', 'Up to 6 years of Android & security updates']::text[]
  WHERE id = '1a7ca5b9-e9c6-4ecc-a350-3b4834042cc5' AND description IS NULL;

-- iPhone XR
UPDATE public.smartphone_catalog SET description = 'The iPhone XR is the most affordable way into iPhone, with a bright 6.1-inch Liquid Retina display, Face ID and the dependable A12 Bionic chip. Its 12 MP camera with Portrait mode takes sharp photos of properties and documents.', highlights = ARRAY['6.1-inch Liquid Retina display', 'A12 Bionic chip', '12 MP camera with Portrait mode', 'Face ID', 'Water resistant (IP67)']::text[]
  WHERE id = '5835d983-46a9-4ddf-bbd1-fc275c4ee44e' AND description IS NULL;

-- iPhone XS
UPDATE public.smartphone_catalog SET description = 'The iPhone XS packs a compact 5.8-inch OLED Super Retina display into a premium stainless-steel design. Dual 12 MP cameras with 2x optical zoom and the A12 Bionic chip handle photos, video calls and apps with ease.', highlights = ARRAY['5.8-inch Super Retina OLED display', 'A12 Bionic chip', 'Dual 12 MP cameras with 2x optical zoom', 'Face ID', 'Water resistant (IP68)']::text[]
  WHERE id = 'e8c2efbf-298a-4162-8068-970a1aa11c47' AND description IS NULL;

-- iPhone 11
UPDATE public.smartphone_catalog SET description = 'The iPhone 11 brings a 6.1-inch Liquid Retina display, the fast A13 Bionic chip and dual 12 MP cameras with an ultra wide lens for fitting a whole room in one shot. Night mode keeps photos clear even in low light.', highlights = ARRAY['6.1-inch Liquid Retina display', 'A13 Bionic chip', 'Dual 12 MP cameras (wide + ultra wide)', 'Night mode', 'Water resistant (IP68)']::text[]
  WHERE id = '48268d25-c2c6-4500-a62d-5bffbb6a0151' AND description IS NULL;

-- iPhone 11 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 11 Pro combines a sharp 5.8-inch Super Retina XDR display with a triple 12 MP camera system: wide, ultra wide and 2x telephoto. The A13 Bionic chip and all-day battery make it a strong, compact work phone.', highlights = ARRAY['5.8-inch Super Retina XDR display', 'A13 Bionic chip', 'Triple 12 MP cameras with 2x telephoto', 'Night mode', 'Water resistant (IP68)']::text[]
  WHERE id = '16fb022c-fbc1-4a9f-b10b-20e55f2f7f56' AND description IS NULL;

-- iPhone 11 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 11 Pro Max offers a large 6.5-inch Super Retina XDR display and the longest battery life of the iPhone 11 family. Its triple 12 MP camera system covers wide, ultra wide and 2x telephoto shots.', highlights = ARRAY['6.5-inch Super Retina XDR display', 'A13 Bionic chip', 'Triple 12 MP cameras with 2x telephoto', 'Longest battery in the 11 series', 'Water resistant (IP68)']::text[]
  WHERE id = '64706828-6798-4db0-b945-3219457c808d' AND description IS NULL;

-- iPhone 12
UPDATE public.smartphone_catalog SET description = 'The iPhone 12 adds 5G, a 6.1-inch OLED Super Retina XDR display and the A14 Bionic chip in a slim flat-edged design. Ceramic Shield front glass makes the screen tougher against everyday drops.', highlights = ARRAY['6.1-inch Super Retina XDR display', 'A14 Bionic chip with 5G', 'Dual 12 MP cameras (wide + ultra wide)', 'Ceramic Shield front', 'MagSafe charging']::text[]
  WHERE id = '88ba0439-0eb9-463d-ba31-146971638e0f' AND description IS NULL;

-- iPhone 12 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 12 Pro brings a stainless-steel design, the A14 Bionic chip and a triple 12 MP camera system with a LiDAR scanner for faster focus in low light. A 6.1-inch Super Retina XDR display and 5G round it out.', highlights = ARRAY['6.1-inch Super Retina XDR display', 'A14 Bionic chip with 5G', 'Triple 12 MP cameras + LiDAR scanner', 'Ceramic Shield front', 'MagSafe charging']::text[]
  WHERE id = 'b05e9f06-523e-44dc-a509-a52ccedf093d' AND description IS NULL;

-- iPhone 12 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 12 Pro Max has a big 6.7-inch Super Retina XDR display and the most advanced camera of the iPhone 12 line, with sensor-shift stabilisation and 2.5x telephoto. The A14 Bionic chip and 5G keep everything fast.', highlights = ARRAY['6.7-inch Super Retina XDR display', 'A14 Bionic chip with 5G', 'Triple 12 MP cameras with 2.5x telephoto', 'LiDAR scanner', 'Ceramic Shield front']::text[]
  WHERE id = '1e691257-7648-4162-9a5a-5eec1a3e45ea' AND description IS NULL;

-- iPhone 13
UPDATE public.smartphone_catalog SET description = 'The iPhone 13 delivers a brighter 6.1-inch Super Retina XDR display, the A15 Bionic chip and a noticeable jump in battery life over the iPhone 12. Dual 12 MP cameras with sensor-shift stabilisation take steady photos and Cinematic mode video.', highlights = ARRAY['6.1-inch Super Retina XDR display', 'A15 Bionic chip with 5G', 'Dual 12 MP cameras with sensor-shift stabilisation', 'Longer battery life', 'Water resistant (IP68)']::text[]
  WHERE id = '00828285-5553-4cce-b894-b49a951f5bac' AND description IS NULL;

-- iPhone 13 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 13 Pro introduces a 120Hz ProMotion display for smooth scrolling, the A15 Bionic chip and a triple 12 MP camera system with 3x telephoto and macro photography. Battery life is strong for a full working day.', highlights = ARRAY['6.1-inch ProMotion display (120Hz)', 'A15 Bionic chip with 5G', 'Triple 12 MP cameras with 3x telephoto', 'Macro photography', 'Water resistant (IP68)']::text[]
  WHERE id = 'c78489fe-a703-49f8-bf1a-80640b77739a' AND description IS NULL;

-- iPhone 13 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 13 Pro Max pairs a large 6.7-inch 120Hz ProMotion display with outstanding battery life, among the best of any iPhone. Its triple 12 MP cameras with 3x telephoto and macro capture fine detail.', highlights = ARRAY['6.7-inch ProMotion display (120Hz)', 'A15 Bionic chip with 5G', 'Triple 12 MP cameras with 3x telephoto', 'Outstanding battery life', 'Water resistant (IP68)']::text[]
  WHERE id = '29810273-a3c0-4b8a-b6ee-73fcac81c724' AND description IS NULL;

-- iPhone 14
UPDATE public.smartphone_catalog SET description = 'The iPhone 14 offers a 6.1-inch Super Retina XDR display, the A15 Bionic chip and an improved 12 MP main camera with the Photonic Engine for better low-light photos. Crash Detection and Action mode video add peace of mind on the road.', highlights = ARRAY['6.1-inch Super Retina XDR display', 'A15 Bionic chip with 5G', '12 MP main camera with Photonic Engine', 'Action mode video', 'Crash Detection']::text[]
  WHERE id = '470a31a2-4ffe-42c7-94ab-9226f32575ae' AND description IS NULL;

-- iPhone 14 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 14 Pro debuts the Dynamic Island, an Always-On 120Hz ProMotion display and a 48 MP main camera for highly detailed photos. The A16 Bionic chip keeps apps and multitasking fast.', highlights = ARRAY['6.1-inch Always-On ProMotion display', 'Dynamic Island', 'A16 Bionic chip with 5G', '48 MP main camera, 3x telephoto', 'Crash Detection']::text[]
  WHERE id = '855eae09-d4bf-4754-b0b4-50c2a3e74df2' AND description IS NULL;

-- iPhone 14 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 14 Pro Max brings the Dynamic Island and a 48 MP main camera to a large 6.7-inch Always-On ProMotion display, with the longest battery life of the iPhone 14 family. The A16 Bionic chip handles everything with ease.', highlights = ARRAY['6.7-inch Always-On ProMotion display', 'Dynamic Island', 'A16 Bionic chip with 5G', '48 MP main camera, 3x telephoto', 'Longest battery in the 14 series']::text[]
  WHERE id = 'be1c682e-ca6e-4828-a220-cf99c4b7742d' AND description IS NULL;

-- iPhone 15
UPDATE public.smartphone_catalog SET description = 'The iPhone 15 brings the Dynamic Island and a 48 MP main camera to the standard iPhone, plus USB-C charging so one cable works with most modern devices. The A16 Bionic chip and colour-infused glass back make it fast and durable.', highlights = ARRAY['6.1-inch Super Retina XDR display', 'Dynamic Island', 'A16 Bionic chip with 5G', '48 MP main camera with 2x zoom', 'USB-C charging']::text[]
  WHERE id = '854bc142-70c9-41f6-b282-9c1a8ca221d7' AND description IS NULL;

-- iPhone 15 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 15 Pro is built from lightweight titanium and powered by the A17 Pro chip. It adds the customisable Action button, a 48 MP main camera with 3x telephoto and fast USB-C with USB 3 speeds.', highlights = ARRAY['6.1-inch Always-On ProMotion display', 'Titanium design', 'A17 Pro chip', '48 MP main camera, 3x telephoto', 'Action button and USB-C (USB 3)']::text[]
  WHERE id = '3b1a105b-416b-4bbd-8c53-553dd38bbb55' AND description IS NULL;

-- iPhone 15 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 15 Pro Max combines a 6.7-inch Always-On ProMotion display, a titanium design and the A17 Pro chip with a 5x telephoto camera for zooming in on distant details. Battery life comfortably covers a long working day.', highlights = ARRAY['6.7-inch Always-On ProMotion display', 'Titanium design', 'A17 Pro chip', '48 MP main camera, 5x telephoto', 'Action button and USB-C (USB 3)']::text[]
  WHERE id = '814c82d3-334e-4dab-9815-087362dad230' AND description IS NULL;

-- iPhone 16
UPDATE public.smartphone_catalog SET description = 'The iPhone 16 runs on the A18 chip and adds the Camera Control button for quick photos, plus the Action button. Its 48 MP Fusion camera and 12 MP ultra wide shoot sharp photos and spatial video, and battery life improves on the iPhone 15.', highlights = ARRAY['6.1-inch Super Retina XDR display', 'A18 chip', '48 MP Fusion camera + 12 MP ultra wide', 'Camera Control and Action button', 'USB-C charging']::text[]
  WHERE id = '85015226-0a7b-48cd-9c94-7d1ad76a0bc8' AND description IS NULL;

-- iPhone 16 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 16 Pro has a larger 6.3-inch Always-On ProMotion display, a titanium design and the A18 Pro chip. Its pro camera system pairs a 48 MP Fusion camera and 48 MP ultra wide with 5x telephoto, controlled with the new Camera Control button.', highlights = ARRAY['6.3-inch Always-On ProMotion display', 'Titanium design', 'A18 Pro chip', '48 MP Fusion + 48 MP ultra wide, 5x telephoto', 'Camera Control and Action button']::text[]
  WHERE id = 'a5a2c877-21c7-4262-8f51-9faa748babf3' AND description IS NULL;

-- iPhone 16 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 16 Pro Max has the biggest iPhone display yet at 6.9 inches and some of the longest battery life of any iPhone. The A18 Pro chip, titanium design and 48 MP pro camera system with 5x telephoto make it a premium choice.', highlights = ARRAY['6.9-inch Always-On ProMotion display', 'Titanium design', 'A18 Pro chip', '48 MP Fusion + 48 MP ultra wide, 5x telephoto', 'Exceptional battery life']::text[]
  WHERE id = '3add72ca-243a-4ff8-af0f-5110d2cf0790' AND description IS NULL;

-- iPhone 17
UPDATE public.smartphone_catalog SET description = 'The iPhone 17 brings a 6.3-inch ProMotion display with 120Hz and Always-On to the standard iPhone for the first time. Powered by the A19 chip, it pairs a 48 MP Fusion camera with a 48 MP ultra wide, and an 18 MP Center Stage front camera for video calls.', highlights = ARRAY['6.3-inch ProMotion display (120Hz, Always-On)', 'A19 chip', '48 MP Fusion + 48 MP ultra wide cameras', '18 MP Center Stage front camera', 'Camera Control and Action button']::text[]
  WHERE id = 'e7eefc66-68d8-4f7d-a3f3-cb37fc5c0b78' AND description IS NULL;

-- iPhone 17 Pro
UPDATE public.smartphone_catalog SET description = 'The iPhone 17 Pro is built around the A19 Pro chip in a new aluminium unibody with a vapour chamber that keeps it cool under heavy use. All three rear cameras are 48 MP, including a 4x telephoto, alongside an 18 MP Center Stage front camera.', highlights = ARRAY['6.3-inch Always-On ProMotion display', 'A19 Pro chip', 'Three 48 MP cameras with 4x telephoto', 'Aluminium unibody with vapour-chamber cooling', '18 MP Center Stage front camera']::text[]
  WHERE id = '34a08954-a154-4453-aca2-0c915e30511c' AND description IS NULL;

-- iPhone 17 Pro Max
UPDATE public.smartphone_catalog SET description = 'The iPhone 17 Pro Max is Apple''s top iPhone, with a large 6.9-inch Always-On ProMotion display and the longest battery life of any iPhone. The A19 Pro chip, vapour-chamber cooling and three 48 MP cameras with 4x telephoto make it the most capable phone in the catalogue.', highlights = ARRAY['6.9-inch Always-On ProMotion display', 'A19 Pro chip', 'Three 48 MP cameras with 4x telephoto', 'Longest battery life of any iPhone', '18 MP Center Stage front camera']::text[]
  WHERE id = '9881ed9d-37cf-4366-8aa1-44e4460fbc42' AND description IS NULL;
