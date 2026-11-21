# Ozon Seller API — what the live API answers (checked 2026-11-18, read-only)

Host `https://api-seller.ozon.ru`, headers `Client-Id` (number from «Настройки → Seller API») and
`Api-Key`. A key works only with the Client-Id of the cabinet it was created in. With another
number the error is `401 {"code":16,"message":"Invalid Api-Key…"}`, not a Client-Id error.

## Methods that work now
| purpose | method | notes |
|---|---|---|
| warehouses | `POST /v2/warehouse/list` `{limit, offset}` | `/v1/warehouse/list` → `400 code 9 «obsolete method cannot be used»` |
| FBS postings (own warehouse) | `POST /v4/posting/fbs/list` `{dir, filter:{since,to}, limit, offset}` | answer `{has_next, cursor, postings}`; `/v3/…` → 404 |
| FBS to assemble | `POST /v4/posting/fbs/unfulfilled/list` `{filter:{cutoff_from,cutoff_to}}` | answer `{has_next, cursor, postings, count}`; `/v3/…` → 404 |
| FBO postings (Ozon warehouse) | `POST /v3/posting/fbo/list` | `/v2/…` → obsolete |
| products | `POST /v3/product/list` `{filter:{visibility:"ALL"}, limit}` | `{items:[{product_id, offer_id, sku, has_fbo_stocks, has_fbs_stocks, archived, …}], total, last_id}` |
| stocks | `POST /v4/product/info/stocks` | `{items:[{product_id, offer_id, stocks:[…]}], total, cursor}` |

Paging moved from offset to **cursor** (`has_next` + `cursor`) on the new versions.

## Warehouse object (fields)
`warehouse_id`, `name`, `status`, `warehouse_type`, `is_rfbs`, `is_express`, `is_kgt`,
`is_waybill_enabled`, `carriage_label_type`, `timetable {timetable_from, timetable_to, working_hours}`,
`working_days`, `sla_cut_in`, `postings_limit`, `address_info {address, latitude, longitude, utc}`.

## Not yet seen live
The test cabinet had no postings (FBS or FBO) in the last 12 months. The posting format (products,
`shipment_date` deadline, statuses, labels) follows the documentation until a cabinet with
orders is checked.
