import React, { useEffect, useMemo, useState, type JSX } from "react";
import type { PersonListItem } from "../../../../shared/contracts";
import { formatApproximateAge } from "./format-approximate-age";
import { groupPeopleBySurname } from "./surname-grouping";

interface SurnameGroupedPeopleListProps {
  people: PersonListItem[];
  selectedPersonId: string | null;
  onSelect(personId: string): void;
}

export function SurnameGroupedPeopleList({ people, selectedPersonId, onSelect }: SurnameGroupedPeopleListProps): JSX.Element {
  const groups = useMemo(() => groupPeopleBySurname(people), [people]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!selectedPersonId) return;
    const selectedGroup = groups.find((group) => group.people.some((person) => person.id === selectedPersonId));
    if (!selectedGroup) return;
    setExpandedGroups((current) => {
      if (current.has(selectedGroup.key)) return current;
      const next = new Set(current);
      next.add(selectedGroup.key);
      return next;
    });
  }, [groups, selectedPersonId]);

  const toggleGroup = (key: string): void => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return <div className="surname-groups">
    {groups.map((group) => {
      const expanded = expandedGroups.has(group.key);
      return <section className="surname-group" key={group.key}>
        <button
          type="button"
          className="surname-group-toggle"
          aria-label={group.label}
          aria-expanded={expanded}
          onClick={() => toggleGroup(group.key)}
        >
          <span className="surname-group-chevron" aria-hidden="true">›</span>
          <span>{group.key === "__pending_surname__" ? "姓氏待确认" : `${group.key}姓`}</span>
          <span className="surname-group-count">{group.people.length}人</span>
        </button>
        {expanded && <div className="surname-group-people">
          {group.people.map((person) => {
            const approximateAge = formatApproximateAge(person.birth, person.death);
            return <button
              className={`person-card ${selectedPersonId === person.id ? "selected" : ""}`}
              type="button"
              key={person.id}
              aria-label={`查看${person.displayName}`}
              onClick={() => onSelect(person.id)}
            >
              <strong>{person.displayName}</strong>
              <span className="text-secondary">{person.aliases.join("、") || "无别名"}</span>
              {approximateAge && <span className="text-secondary">{approximateAge}</span>}
            </button>;
          })}
        </div>}
      </section>;
    })}
  </div>;
}
