-- A payload's marks are in its address and in the cipher's associated data. A read takes them from the ref; a
-- re-encrypt has only the row, so the row keeps them too. Null is no marks.
alter table payloads add column marks text[];
