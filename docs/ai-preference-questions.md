# AI tile preference questions and exclusion test

The English question bank is seeded into the database. The room selector comes first; each project then receives ten common questions and two room-specific questions. Start a **New project** to load this set rather than resuming a saved questionnaire.

## Common questions

- Which surfaces are you tiling: floor, walls, or both? Describe any feature wall or backsplash you want.
- What area needs tiling, in square metres? Give the floor area and wall area separately if both need tiles; include room dimensions if you know them.
- What is your tile budget per square metre in RWF, excluding installation? Give a preferred range and a maximum, or say flexible.
- Which colors should dominate your tiles, and which colors should we avoid? For example: cream, ivory, beige, smoky grey, warm brown, or bold accents.
- Which tile look do you prefer: marble, wood, concrete, natural stone, geometric, or plain? Describe whether the pattern should be subtle or a bold feature.
- Which finish do you prefer: matte, satin, or glossy? Tell us whether avoiding glare or having a polished appearance matters more, or say no preference.
- Which tile dimensions do you prefer: 30x30 cm, 40x40 cm, 60x60 cm, rectangular, or another format? Say flexible if you want us to suggest a format.
- What wall and ceiling colors will remain in the room? Mention any existing tiles or finishes the new tiles must coordinate with.
- How much natural light does the room receive: little, moderate, or plenty? Is the artificial lighting mainly warm or cool?
- How busy is the space, and who uses it: adults, children, pets, or frequent visitors? Describe your priorities for everyday cleaning and use.

## living room questions

- What colors and materials are your sofa, chairs, and tables? Mention the dominant furniture color and any wood, glass, or metal finishes.
- What colors and patterns are your curtains or blinds, rugs, and interior doors? Should the floor blend quietly with them or be the main design feature?

## bedroom questions

- What colors and materials are your bed, wardrobes, bedding, and curtains? Which of these existing finishes should the tiles complement?
- For the bedroom, what matters most: a calm look, a warm appearance, easy cleaning, or another priority? Do you plan to use rugs over the tiled floor?

## kitchen questions

- What colors and finishes are your kitchen cabinets, worktops, and appliances? Do you want the tiles to match them or provide a contrasting accent?
- Which kitchen areas need tiles: the floor, backsplash, full walls, or a combination? Describe areas near the sink or cooker and any cleaning concerns.

## bathroom questions

- Which bathroom surfaces need tiles, including the shower floor and walls? Describe where water reaches the floor and any concerns about grip when wet.
- Should bathroom wall tiles cover the full height or only part of the wall? Describe your preferred floor-and-wall color pairing and any accent area.

## Actual tile record

**Mixed Diagonal Marble Parquet Floor — FGP33760J**

- Matte ceramic floor tile, 30×30 cm, 9,500 RWF/m².
- Cream, ivory, beige and smoky-grey marble textures in broad diagonal interlocking bands.
- Suitable for floors in living rooms, bedrooms, bathrooms and kitchens.
- Box coverage: 1.53 m², 17 pieces. Visualizer layout: Two-turn.
- At verification on 2026-10-05: active in the catalog and excluded from AI recommendations.

## Example answers for a living-room test

These are example customer preferences chosen to match the tile, not additional product specifications.

| Question | Answer to enter |
|---|---|
| Which room are you designing? | Living room |
| Which surfaces are you tiling: floor, walls, or both? Describe any feature wall or backsplash you want. | Floor only; the floor should be the main design feature. |
| What area needs tiling, in square metres? Give the floor area and wall area separately if both need tiles; include room dimensions if you know them. | 24 m² of floor, in a 6 m × 4 m living room. No wall tiles. |
| What is your tile budget per square metre in RWF, excluding installation? Give a preferred range and a maximum, or say flexible. | 9,000–10,000 RWF per m² for tiles, maximum 10,000 RWF/m², excluding installation. |
| Which colors should dominate your tiles, and which colors should we avoid? For example: cream, ivory, beige, smoky grey, warm brown, or bold accents. | Cream, ivory and beige with smoky-grey accents. Avoid bright colors. |
| Which tile look do you prefer: marble, wood, concrete, natural stone, geometric, or plain? Describe whether the pattern should be subtle or a bold feature. | Marble-effect tiles with broad diagonal interlocking parquet bands and a modern geometric pattern. |
| Which finish do you prefer: matte, satin, or glossy? Tell us whether avoiding glare or having a polished appearance matters more, or say no preference. | Matte; I want to avoid a glossy or highly reflective floor. |
| Which tile dimensions do you prefer: 30x30 cm, 40x40 cm, 60x60 cm, rectangular, or another format? Say flexible if you want us to suggest a format. | 30×30 cm tiles. |
| What wall and ceiling colors will remain in the room? Mention any existing tiles or finishes the new tiles must coordinate with. | Warm-white painted walls and a white ceiling; no existing tiles to match. |
| How much natural light does the room receive: little, moderate, or plenty? Is the artificial lighting mainly warm or cool? | Moderate natural daylight and warm artificial lighting. |
| How busy is the space, and who uses it: adults, children, pets, or frequent visitors? Describe your priorities for everyday cleaning and use. | A family living room with moderate daily foot traffic. Easy everyday cleaning matters. |
| What colors and materials are your sofa, chairs, and tables? Mention the dominant furniture color and any wood, glass, or metal finishes. | A smoky-grey sofa, cream accent chairs, a light-oak table with glass details. |
| What colors and patterns are your curtains or blinds, rugs, and interior doors? Should the floor blend quietly with them or be the main design feature? | Plain beige curtains, light-oak doors and a neutral rug. Let the diagonal floor pattern be the feature. |

## Verify exclusion

1. Keep FGP33760J excluded in Admin → Knowledge Base → Recommendation exclusions.
2. Start a new chatbot project, select Living room, and enter the answers above.
3. The target SKU must be absent from all new recommendation cards, even though the preferences match it.
4. For a comparison, an admin can choose Allow again and start another new project with the same answers. The tile becomes eligible, but ranking among other matching tiles is not guaranteed.
5. Exclude it again to restore the original setting. Previous chat recommendations remain historical.

Repeatable question-only seed: `cd server && npm run prisma:seed:preferences`. The seed preserves old rows as inactive and does not modify any tile.
