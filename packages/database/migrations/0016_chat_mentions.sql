-- Mentions and canvas anchors on chat messages, both nullable because every
-- existing message has neither. mentions is a plain uuid[] rather than a join
-- table: the ids are filtered against drawing membership when the message is
-- sent, and the record of who was mentioned must survive that member later
-- being removed. anchor holds opaque Excalidraw element ids, which the server
-- never resolves against scene content — the scene is a moving target, so a
-- dangling anchor is only detectable against the scene the reader has open.
ALTER TABLE chat_messages
  ADD COLUMN mentions UUID[],
  ADD COLUMN anchor JSONB;
