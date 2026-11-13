//! Each file of a delivery (sent or received) and how far it is, as the Pet Post window
//! lists it: every file when there are few; when there are many (a folder), the ones moving,
//! the ones that failed, the last few finished and the next few waiting, with the counts.

use std::sync::{Arc, Mutex};

use serde::Serialize;

use super::{lock, Transfer};

/// At most this many files listed (the counts say the rest).
pub const SHOWN: usize = 8;
/// Of them, the last few finished.
const FINISHED_SHOWN: usize = 3;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub done: u64,
    /// "waiting" | "moving" | "done" | "failed" | "skipped" (the receiver didn't want it).
    pub state: &'static str,
    /// Sending: where it is on this computer (to send it again).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Item {
    pub fn new(id: &str, name: &str, size: u64, path: Option<String>) -> Self {
        Item { id: id.into(), name: name.into(), size, state: "waiting", path, ..Default::default() }
    }
}

/// How many files are where.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Tally {
    pub done: usize,
    pub moving: usize,
    pub waiting: usize,
    pub failed: usize,
    pub skipped: usize,
}

#[derive(Debug, Default)]
pub struct Items {
    list: Vec<Item>,
    /// Indexes, in the order they finished.
    finished: Vec<usize>,
}

pub type Shared = Arc<Mutex<Items>>;

impl Items {
    pub fn new(list: Vec<Item>) -> Self {
        Items { list, finished: Vec::new() }
    }

    fn find(&mut self, id: &str) -> Option<(usize, &mut Item)> {
        self.list.iter_mut().enumerate().find(|(_, x)| x.id == id)
    }

    pub fn start(&mut self, id: &str) {
        if let Some((_, x)) = self.find(id) {
            if x.state == "waiting" {
                x.state = "moving";
            }
        }
    }

    pub fn add(&mut self, id: &str, n: u64) {
        if let Some((_, x)) = self.find(id) {
            x.state = "moving";
            x.done += n;
        }
    }

    pub fn finish(&mut self, id: &str) {
        if let Some((i, x)) = self.find(id) {
            if x.state != "done" {
                x.state = "done";
                x.done = x.size;
                self.finished.push(i);
            }
        }
    }

    pub fn fail(&mut self, id: &str, error: Option<String>) {
        if let Some((_, x)) = self.find(id) {
            if x.state != "done" {
                x.state = "failed";
                x.error = error;
            }
        }
    }

    pub fn skip(&mut self, id: &str) {
        if let Some((_, x)) = self.find(id) {
            x.state = "skipped";
        }
    }

    /// Everything not skipped is in (the receiver said so).
    pub fn finish_all(&mut self) {
        let ids: Vec<String> = self.list.iter().filter(|x| x.state != "skipped").map(|x| x.id.clone()).collect();
        for id in ids {
            self.finish(&id);
        }
    }

    /// The delivery stopped: what was moving failed with it.
    pub fn stop_moving(&mut self) {
        for x in &mut self.list {
            if x.state == "moving" {
                x.state = "failed";
            }
        }
    }

    pub fn tally(&self) -> Tally {
        let mut t = Tally::default();
        for x in &self.list {
            match x.state {
                "done" => t.done += 1,
                "moving" => t.moving += 1,
                "failed" => t.failed += 1,
                "skipped" => t.skipped += 1,
                _ => t.waiting += 1,
            }
        }
        t
    }

    /// The files to list (in their own order) and the counts.
    pub fn view(&self) -> (Vec<Item>, Tally) {
        let tally = self.tally();
        if self.list.len() <= SHOWN {
            return (self.list.clone(), tally);
        }
        let mut pick: Vec<usize> = Vec::new();
        let take = |i: usize, pick: &mut Vec<usize>| {
            if pick.len() < SHOWN && !pick.contains(&i) {
                pick.push(i);
            }
        };
        for (i, x) in self.list.iter().enumerate() {
            if x.state == "moving" || x.state == "failed" {
                take(i, &mut pick);
            }
        }
        for &i in self.finished.iter().rev().take(FINISHED_SHOWN) {
            take(i, &mut pick);
        }
        for (i, x) in self.list.iter().enumerate() {
            if x.state == "waiting" {
                take(i, &mut pick);
            }
        }
        pick.sort_unstable();
        (pick.into_iter().map(|i| self.list[i].clone()).collect(), tally)
    }
}

impl Transfer {
    /// With the files and how far each is.
    pub(crate) fn listing(mut self, items: &Items) -> Self {
        let (list, tally) = items.view();
        self.items = list;
        self.tally = Some(tally);
        self
    }

    pub(crate) fn listing_shared(self, items: &Shared) -> Self {
        let guard = lock(items);
        self.listing(&guard)
    }

    /// With every file (at the end, so what didn't get there can be sent again).
    pub(crate) fn listing_all(mut self, items: &Shared) -> Self {
        let guard = lock(items);
        self.items = guard.list.clone();
        self.tally = Some(guard.tally());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(n: usize) -> Items {
        Items::new((0..n).map(|i| Item::new(&i.to_string(), &format!("f{i}"), 10, None)).collect())
    }

    #[test]
    fn a_few_files_are_all_listed() {
        let mut it = items(3);
        it.add("1", 4);
        it.finish("0");
        it.skip("2");
        let (list, t) = it.view();
        assert_eq!(list.iter().map(|x| x.state).collect::<Vec<_>>(), ["done", "moving", "skipped"]);
        assert_eq!(list[1].done, 4);
        assert_eq!(t, Tally { done: 1, moving: 1, waiting: 0, failed: 0, skipped: 1 });
    }

    #[test]
    fn many_files_list_the_moving_the_last_finished_and_the_next_waiting() {
        let mut it = items(120);
        for i in 0..38 {
            it.finish(&i.to_string());
        }
        it.add("38", 3);
        it.add("39", 7);
        let (list, t) = it.view();
        let names: Vec<&str> = list.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["f35", "f36", "f37", "f38", "f39", "f40", "f41", "f42"]);
        assert_eq!(t, Tally { done: 38, moving: 2, waiting: 80, failed: 0, skipped: 0 });
        it.fail("39", Some("HTTP 500".into()));
        it.stop_moving();
        let t = it.tally();
        assert_eq!((t.failed, t.moving), (2, 0));
    }
}
