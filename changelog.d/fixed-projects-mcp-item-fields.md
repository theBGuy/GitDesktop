- The Projects MCP tools leave an item's built-in Title out of its field values
  (`list_project_items` gives it as the item's title), and `list_project_items`
  reads a very large `limit` as 500, its documented maximum.
